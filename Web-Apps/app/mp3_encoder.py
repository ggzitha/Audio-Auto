"""
Multi-Codec Encoder Module — Audio-Auto / aiosendspin integration  v6.0
═══════════════════════════════════════════════════════════════════════
Monkey-patches aiosendspin's PlayerV1Role to support MP3, FLAC, and OPUS
codecs in addition to the native PCM path.

OPUS is implemented server-side: when 'opus' codec is selected in the UI
the server transcodes to OPUS frames and the web client decodes natively.
ESP32 clients will receive server-transcoded MP3/FLAC instead.
"""

import av
from aiosendspin.server.audio import AudioFormat, _get_av, _validate_pcm_buffer_length
from aiosendspin.server.roles.player.v1 import PlayerV1Role
from aiosendspin.server.roles.base import AudioRequirements

# ═══════════════════════════════════════════════════════════════════════════════
# Extend AudioCodec enum — aiosendspin only ships pcm/flac/opus, we need mp3
# This MUST run at import time, before any client/hello is deserialized.
# ═══════════════════════════════════════════════════════════════════════════════
def _extend_audio_codec_enum():
    """Add 'mp3' to the AudioCodec enum so the server accepts it in client/hello."""
    try:
        from aiosendspin.models.types import AudioCodec
        if "mp3" not in AudioCodec._value2member_map_:
            # Create a new enum member and register it
            new_member = object.__new__(AudioCodec)
            new_member._name_ = "MP3"
            new_member._value_ = "mp3"
            AudioCodec._value2member_map_["mp3"] = new_member
            AudioCodec._member_map_["MP3"] = new_member
            if hasattr(AudioCodec, '_member_names_'):
                AudioCodec._member_names_.append("MP3")
            # setattr on enums can fail in some Python versions — not critical
            try:
                setattr(AudioCodec, "MP3", new_member)
            except (AttributeError, TypeError):
                pass
            print("[Codec] Extended AudioCodec enum with 'mp3'")
        else:
            print("[Codec] AudioCodec already has 'mp3'")
    except Exception as e:
        print(f"[Codec] WARNING: Failed to extend AudioCodec: {e}")

_extend_audio_codec_enum()



# ═══════════════════════════════════════════════════════════════════════════════
# MP3 Encoder
# ═══════════════════════════════════════════════════════════════════════════════
class Mp3Encoder:
    """MP3 audio encoder transformer."""

    def __init__(
        self,
        *,
        sample_rate: int,
        bit_depth: int,
        channels: int,
        chunk_duration_us: int = 25_000,
        options=None,
    ) -> None:
        self._sample_rate = sample_rate
        self._channels = channels
        self._chunk_duration_us = chunk_duration_us
        self._encoder = None
        self._frame_stride = (bit_depth // 8) * channels
        self._chunk_samples = int(sample_rate * chunk_duration_us / 1_000_000)
        self._buffer = bytearray()
        self._initialized = False
        self._stream_start_timestamp_us = None
        self._output_frame_count = 0
        self._first_input_timestamp_us = None
        self._chunks_encoded_total = 0
        self._last_input_timestamp_us = None
        self._dur_residue = 0

    @property
    def frame_duration_us(self) -> int:
        return self._chunk_duration_us

    @property
    def pending_timestamp_us(self) -> int | None:
        if self._stream_start_timestamp_us is None:
            return None
        cumulative_samples = self._output_frame_count * self._chunk_samples
        return self._stream_start_timestamp_us + (
            cumulative_samples * 1_000_000 // self._sample_rate
        )

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return

        av = _get_av()
        self._encoder = av.AudioCodecContext.create("libmp3lame", "w")
        self._encoder.sample_rate = self._sample_rate
        self._encoder.layout = "stereo" if self._channels == 2 else "mono"
        self._encoder.format = "s16p"  # lame uses planar s16

        with av.logging.Capture():
            self._encoder.open()

        # FIX v6.1: After encoder initialization, recalculate chunk_size to match
        # the encoder's actual frame size. This prevents alignment issues when
        # the resampler's output buffer size differs from the pre-calculated chunk_size.
        if self._encoder.frame_size:
            self._chunk_samples = self._encoder.frame_size
            self._chunk_duration_us = self._chunk_samples * 1_000_000 // self._sample_rate
            self._frame_stride = (16 // 8) * self._channels  # Recalculate for new chunk_samples

        self._initialized = True

    def _encode_chunk(self, chunk_pcm: bytes) -> bytes:
        assert self._encoder is not None
        av = _get_av()
        
        # mp3 uses s16p, but our input is s16 interleaved. 
        # We need an audio resampler to convert interleaved to planar
        if not hasattr(self, '_resampler'):
            self._resampler = av.AudioResampler(
                format=self._encoder.format,
                layout=self._encoder.layout,
                rate=self._encoder.sample_rate,
            )

        frame = av.AudioFrame(
            format="s16",
            layout="stereo" if self._channels == 2 else "mono",
            samples=self._chunk_samples,
        )
        frame.sample_rate = self._sample_rate
        frame.planes[0].update(chunk_pcm)
        
        frame = self._resampler.resample(frame)

        output = bytearray()
        packets = self._encoder.encode(frame)
        for packet in packets:
            output.extend(bytes(packet))
        return bytes(output)

    def process(self, pcm: bytes, timestamp_us: int, duration_us: int):
        self._ensure_initialized()

        if self._last_input_timestamp_us is not None:
            input_gap = timestamp_us - self._last_input_timestamp_us
            if input_gap > 1_500_000:
                self._stream_start_timestamp_us = None
                self._output_frame_count = 0
                self._first_input_timestamp_us = timestamp_us
                self._chunks_encoded_total = 0
                self._dur_residue = 0
        self._last_input_timestamp_us = timestamp_us

        if self._first_input_timestamp_us is None:
            self._first_input_timestamp_us = timestamp_us

        self._buffer.extend(pcm)
        frames = []
        chunk_size = self._chunk_samples * self._frame_stride

        while len(self._buffer) >= chunk_size:
            chunk_pcm = bytes(self._buffer[:chunk_size])
            del self._buffer[:chunk_size]
            encoded = self._encode_chunk(chunk_pcm)
            self._chunks_encoded_total += 1
            if encoded:
                if self._stream_start_timestamp_us is None:
                    assert self._first_input_timestamp_us is not None
                    encoder_delay_chunks = max(self._chunks_encoded_total - 1, 0)
                    delay_samples = encoder_delay_chunks * self._chunk_samples
                    self._stream_start_timestamp_us = self._first_input_timestamp_us + (
                        delay_samples * 1_000_000 // self._sample_rate
                    )
                self._dur_residue += self._chunk_samples * 1_000_000
                delta_us, self._dur_residue = divmod(self._dur_residue, self._sample_rate)
                frames.append((encoded, delta_us))
                self._output_frame_count += 1

        return frames

    def flush(self):
        if not self._buffer:
            return []

        self._ensure_initialized()
        chunk_size = self._chunk_samples * self._frame_stride

        padding_needed = chunk_size - len(self._buffer)
        self._buffer.extend(bytes(padding_needed))
        chunk_pcm = bytes(self._buffer)
        self._buffer.clear()

        encoded = self._encode_chunk(chunk_pcm)
        if encoded:
            self._output_frame_count += 1
            self._dur_residue += self._chunk_samples * 1_000_000
            delta_us, self._dur_residue = divmod(self._dur_residue, self._sample_rate)
            return [(encoded, delta_us)]
        return []

    def get_header(self) -> bytes | None:
        return None

    def reset(self) -> None:
        self._encoder = None
        self._buffer.clear()
        self._initialized = False
        self._stream_start_timestamp_us = None
        self._output_frame_count = 0
        self._first_input_timestamp_us = None
        self._chunks_encoded_total = 0
        self._last_input_timestamp_us = None
        self._dur_residue = 0


# ═══════════════════════════════════════════════════════════════════════════════
# FLAC Encoder
# ═══════════════════════════════════════════════════════════════════════════════
class FlacEncoder:
    """FLAC (lossless) encoder transformer for Sendspin."""

    def __init__(
        self,
        *,
        sample_rate: int,
        bit_depth: int,
        channels: int,
        chunk_duration_us: int = 25_000,
        options=None,
    ) -> None:
        self._sample_rate = sample_rate
        self._channels = channels
        self._bit_depth = bit_depth
        self._chunk_duration_us = chunk_duration_us
        self._encoder = None
        self._frame_stride = (bit_depth // 8) * channels
        self._chunk_samples = int(sample_rate * chunk_duration_us / 1_000_000)
        self._buffer = bytearray()
        self._initialized = False
        self._stream_start_timestamp_us = None
        self._output_frame_count = 0
        self._first_input_timestamp_us = None
        self._chunks_encoded_total = 0
        self._last_input_timestamp_us = None
        self._dur_residue = 0
        self._header_bytes = None

    @property
    def frame_duration_us(self) -> int:
        return self._chunk_duration_us

    @property
    def pending_timestamp_us(self) -> int | None:
        if self._stream_start_timestamp_us is None:
            return None
        cumulative_samples = self._output_frame_count * self._chunk_samples
        return self._stream_start_timestamp_us + (
            cumulative_samples * 1_000_000 // self._sample_rate
        )

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return

        av = _get_av()
        self._encoder = av.AudioCodecContext.create("flac", "w")
        self._encoder.sample_rate = self._sample_rate
        self._encoder.layout = "stereo" if self._channels == 2 else "mono"
        self._encoder.format = "s16"  # FLAC supports s16 directly

        with av.logging.Capture():
            self._encoder.open()

        if self._encoder.frame_size and self._encoder.frame_size > 0:
            self._chunk_samples = self._encoder.frame_size
            self._chunk_duration_us = self._chunk_samples * 1_000_000 // self._sample_rate

        # Extract FLAC streaminfo header from the encoder's extradata
        if self._encoder.extradata:
            self._header_bytes = bytes(self._encoder.extradata)

        self._initialized = True

    def _encode_chunk(self, chunk_pcm: bytes) -> bytes:
        assert self._encoder is not None
        av = _get_av()

        # FLAC encoder expects planar s16p format, not interleaved s16
        # We need to use a resampler to convert interleaved PCM to planar
        if not hasattr(self, '_resampler'):
            self._resampler = av.AudioResampler(
                format="s16p",  # Planar format for FLAC
                layout="stereo" if self._channels == 2 else "mono",
                rate=self._sample_rate,
            )

        # Create frame with interleaved s16 format
        input_frame = av.AudioFrame(
            format="s16",
            layout="stereo" if self._channels == 2 else "mono",
            samples=self._chunk_samples,
        )
        input_frame.sample_rate = self._sample_rate
        input_frame.planes[0].update(chunk_pcm)

        # Resample to planar format
        planar_frame = self._resampler.resample(input_frame)
        if planar_frame is None:
            return b''

        output = bytearray()
        packets = self._encoder.encode(planar_frame)
        for packet in packets:
            output.extend(bytes(packet))
        return bytes(output)

    def process(self, pcm: bytes, timestamp_us: int, duration_us: int):
        self._ensure_initialized()

        if self._last_input_timestamp_us is not None:
            input_gap = timestamp_us - self._last_input_timestamp_us
            if input_gap > 1_500_000:
                self._stream_start_timestamp_us = None
                self._output_frame_count = 0
                self._first_input_timestamp_us = timestamp_us
                self._chunks_encoded_total = 0
                self._dur_residue = 0
        self._last_input_timestamp_us = timestamp_us

        if self._first_input_timestamp_us is None:
            self._first_input_timestamp_us = timestamp_us

        self._buffer.extend(pcm)
        frames = []
        chunk_size = self._chunk_samples * self._frame_stride

        while len(self._buffer) >= chunk_size:
            chunk_pcm = bytes(self._buffer[:chunk_size])
            del self._buffer[:chunk_size]
            encoded = self._encode_chunk(chunk_pcm)
            self._chunks_encoded_total += 1
            if encoded:
                if self._stream_start_timestamp_us is None:
                    assert self._first_input_timestamp_us is not None
                    encoder_delay_chunks = max(self._chunks_encoded_total - 1, 0)
                    delay_samples = encoder_delay_chunks * self._chunk_samples
                    self._stream_start_timestamp_us = self._first_input_timestamp_us + (
                        delay_samples * 1_000_000 // self._sample_rate
                    )
                self._dur_residue += self._chunk_samples * 1_000_000
                delta_us, self._dur_residue = divmod(self._dur_residue, self._sample_rate)
                frames.append((encoded, delta_us))
                self._output_frame_count += 1

        return frames

    def flush(self):
        if not self._buffer:
            return []

        self._ensure_initialized()
        chunk_size = self._chunk_samples * self._frame_stride

        padding_needed = chunk_size - len(self._buffer)
        self._buffer.extend(bytes(padding_needed))
        chunk_pcm = bytes(self._buffer)
        self._buffer.clear()

        encoded = self._encode_chunk(chunk_pcm)
        if encoded:
            self._output_frame_count += 1
            self._dur_residue += self._chunk_samples * 1_000_000
            delta_us, self._dur_residue = divmod(self._dur_residue, self._sample_rate)
            return [(encoded, delta_us)]
        return []

    def get_header(self) -> bytes | None:
        self._ensure_initialized()
        return self._header_bytes

    def reset(self) -> None:
        self._encoder = None
        self._buffer.clear()
        self._initialized = False
        self._stream_start_timestamp_us = None
        self._output_frame_count = 0
        self._first_input_timestamp_us = None
        self._chunks_encoded_total = 0
        self._last_input_timestamp_us = None
        self._dur_residue = 0
        self._header_bytes = None


# ═══════════════════════════════════════════════════════════════════════════════
# Opus Encoder — server-side transcode for ESP32 clients
# ═══════════════════════════════════════════════════════════════════════════════
class OpusEncoder:
    """Opus encoder transformer. ESP32 clients cannot decode Opus natively,
    so the server transcodes to Opus for web clients only. ESP32 clients
    will be force-set to MP3/PCM by the manager logic."""

    def __init__(
        self,
        *,
        sample_rate: int,
        bit_depth: int,
        channels: int,
        chunk_duration_us: int = 20_000,  # Opus standard: 20ms frames
        options=None,
    ) -> None:
        self._sample_rate = sample_rate
        self._channels = channels
        self._chunk_duration_us = chunk_duration_us
        self._encoder = None
        self._frame_stride = (bit_depth // 8) * channels
        self._chunk_samples = int(sample_rate * chunk_duration_us / 1_000_000)
        self._buffer = bytearray()
        self._initialized = False
        self._stream_start_timestamp_us = None
        self._output_frame_count = 0
        self._first_input_timestamp_us = None
        self._chunks_encoded_total = 0
        self._last_input_timestamp_us = None
        self._dur_residue = 0
        self._header_bytes = None

    @property
    def frame_duration_us(self) -> int:
        return self._chunk_duration_us

    @property
    def pending_timestamp_us(self) -> int | None:
        if self._stream_start_timestamp_us is None:
            return None
        cumulative_samples = self._output_frame_count * self._chunk_samples
        return self._stream_start_timestamp_us + (
            cumulative_samples * 1_000_000 // self._sample_rate
        )

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return

        av = _get_av()
        self._encoder = av.AudioCodecContext.create("libopus", "w")
        self._encoder.sample_rate = 48000  # Opus operates at 48 kHz
        self._encoder.layout = "stereo" if self._channels == 2 else "mono"
        self._encoder.format = "s16"

        with av.logging.Capture():
            self._encoder.open()

        if self._encoder.frame_size and self._encoder.frame_size > 0:
            self._chunk_samples = self._encoder.frame_size
            self._chunk_duration_us = self._chunk_samples * 1_000_000 // 48000

        # Need a resampler from input rate to 48 kHz for Opus
        if self._sample_rate != 48000:
            self._resampler = av.AudioResampler(
                format="s16",
                layout=self._encoder.layout,
                rate=48000,
            )
        else:
            self._resampler = None

        if self._encoder.extradata:
            self._header_bytes = bytes(self._encoder.extradata)

        self._initialized = True

    def _encode_chunk(self, chunk_pcm: bytes) -> bytes:
        assert self._encoder is not None
        av = _get_av()

        frame = av.AudioFrame(
            format="s16",
            layout="stereo" if self._channels == 2 else "mono",
            samples=self._chunk_samples,
        )
        frame.sample_rate = self._sample_rate
        frame.planes[0].update(chunk_pcm)

        if self._resampler:
            frame = self._resampler.resample(frame)

        output = bytearray()
        packets = self._encoder.encode(frame)
        for packet in packets:
            output.extend(bytes(packet))
        return bytes(output)

    def process(self, pcm: bytes, timestamp_us: int, duration_us: int):
        self._ensure_initialized()

        if self._last_input_timestamp_us is not None:
            input_gap = timestamp_us - self._last_input_timestamp_us
            if input_gap > 1_500_000:
                self._stream_start_timestamp_us = None
                self._output_frame_count = 0
                self._first_input_timestamp_us = timestamp_us
                self._chunks_encoded_total = 0
                self._dur_residue = 0
        self._last_input_timestamp_us = timestamp_us

        if self._first_input_timestamp_us is None:
            self._first_input_timestamp_us = timestamp_us

        self._buffer.extend(pcm)
        frames = []
        chunk_size = self._chunk_samples * self._frame_stride

        while len(self._buffer) >= chunk_size:
            chunk_pcm = bytes(self._buffer[:chunk_size])
            del self._buffer[:chunk_size]
            encoded = self._encode_chunk(chunk_pcm)
            self._chunks_encoded_total += 1
            if encoded:
                if self._stream_start_timestamp_us is None:
                    assert self._first_input_timestamp_us is not None
                    encoder_delay_chunks = max(self._chunks_encoded_total - 1, 0)
                    delay_samples = encoder_delay_chunks * self._chunk_samples
                    self._stream_start_timestamp_us = self._first_input_timestamp_us + (
                        delay_samples * 1_000_000 // self._sample_rate
                    )
                self._dur_residue += self._chunk_samples * 1_000_000
                delta_us, self._dur_residue = divmod(self._dur_residue, self._sample_rate)
                frames.append((encoded, delta_us))
                self._output_frame_count += 1

        return frames

    def flush(self):
        if not self._buffer:
            return []

        self._ensure_initialized()
        chunk_size = self._chunk_samples * self._frame_stride

        padding_needed = chunk_size - len(self._buffer)
        self._buffer.extend(bytes(padding_needed))
        chunk_pcm = bytes(self._buffer)
        self._buffer.clear()

        encoded = self._encode_chunk(chunk_pcm)
        if encoded:
            self._output_frame_count += 1
            self._dur_residue += self._chunk_samples * 1_000_000
            delta_us, self._dur_residue = divmod(self._dur_residue, self._sample_rate)
            return [(encoded, delta_us)]
        return []

    def get_header(self) -> bytes | None:
        self._ensure_initialized()
        return self._header_bytes

    def reset(self) -> None:
        self._encoder = None
        self._buffer.clear()
        self._initialized = False
        self._stream_start_timestamp_us = None
        self._output_frame_count = 0
        self._first_input_timestamp_us = None
        self._chunks_encoded_total = 0
        self._last_input_timestamp_us = None
        self._dur_residue = 0
        self._header_bytes = None


# ═══════════════════════════════════════════════════════════════════════════════
# Codec → Encoder class mapping
# ═══════════════════════════════════════════════════════════════════════════════
CODEC_ENCODER_MAP = {
    "mp3":  Mp3Encoder,
    "flac": FlacEncoder,
    "opus": OpusEncoder,
}


def _make_encoder_requirements(self, codec_name: str, encoder_cls, fmt, force: bool):
    """Shared helper: create AudioRequirements with a custom encoder transformer."""
    support = self._client.info.player_support
    if support is None:
        self._audio_requirements = None
        return

    group = self._client.group
    frame_duration_us = 25_000 if codec_name != "opus" else 20_000
    channel_id = group.get_channel_for_player(self._client.client_id)
    channel_id_int = channel_id.int

    transformer = group.transformer_pool.get_or_create(
        encoder_cls,
        channel_id=channel_id_int,
        sample_rate=fmt.sample_rate,
        bit_depth=fmt.bit_depth,
        channels=fmt.channels,
        chunk_duration_us=frame_duration_us,
    )

    self._audio_requirements = AudioRequirements(
        sample_rate=fmt.sample_rate,
        bit_depth=fmt.bit_depth,
        channels=fmt.channels,
        transformer=transformer,
        channel_id=channel_id,
        frame_duration_us=frame_duration_us,
    )


def patch_aiosendspin_for_mp3():
    """Monkey-patch aiosendspin to support MP3, FLAC, and OPUS codecs."""

    original_ensure = PlayerV1Role._ensure_audio_requirements

    def _patched_ensure_audio_requirements(self, *, force: bool = False) -> None:
        if self._audio_requirements is not None and not force:
            return

        support = self._client.info.player_support
        if support is None:
            self._audio_requirements = None
            return

        audio_format = self._preferred_format
        audio_codec = self._preferred_codec
        if audio_format is None or audio_codec is None:
            self._audio_requirements = None
            return

        # Check if this is one of our custom codecs
        encoder_cls = CODEC_ENCODER_MAP.get(audio_codec)
        if encoder_cls is not None:
            _make_encoder_requirements(self, audio_codec, encoder_cls, audio_format, force)
            return

        # Fall through to original for PCM
        original_ensure(self, force=force)

    PlayerV1Role._ensure_audio_requirements = _patched_ensure_audio_requirements

    # Also patch _send_stream_start_message to handle custom codecs
    from aiosendspin.models.core import StreamStartMessage, StreamStartPayload
    from aiosendspin.models.player import StreamStartPlayer
    import base64

    original_send = PlayerV1Role._send_stream_start_message

    def _patched_send_stream_start_message(self):
        req = self.get_audio_requirements()
        if req is None or not self.has_connection():
            return

        transformer = req.transformer
        # Check if transformer is one of our custom encoders
        codec_name = None
        for name, cls in CODEC_ENCODER_MAP.items():
            if isinstance(transformer, cls):
                codec_name = name
                break

        if codec_name is not None:
            # Get codec header if available (FLAC streaminfo, Opus header)
            header_data = transformer.get_header() if hasattr(transformer, 'get_header') else None
            codec_header = base64.b64encode(header_data).decode() if header_data else None

            current_format = (codec_name, req.sample_rate, req.channels, req.bit_depth, codec_header)
            if self._stream_started and self._last_sent_format == current_format:
                return

            stream_start = StreamStartMessage(
                payload=StreamStartPayload(
                    player=StreamStartPlayer(
                        codec=codec_name,
                        sample_rate=req.sample_rate,
                        channels=req.channels,
                        bit_depth=req.bit_depth,
                        codec_header=codec_header,
                    )
                )
            )
            self.send_message(stream_start)
            is_initial = not self._stream_started
            self._stream_started = True
            self._last_sent_format = current_format

            if is_initial and self._buffer_tracker is not None:
                self._buffer_tracker.set_send_blocked(200_000)
            return

        original_send(self)

    PlayerV1Role._send_stream_start_message = _patched_send_stream_start_message
