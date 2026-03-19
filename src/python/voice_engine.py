"""
NovaAssist Voice Engine — STT via AWS Nova Sonic, with Silero VAD and daemon mode.
"""
import os, sys, asyncio, base64, json, uuid, subprocess, pyaudio, struct as _struct

SONIC_AVAILABLE = False
try:
    from aws_sdk_bedrock_runtime.client import BedrockRuntimeClient, InvokeModelWithBidirectionalStreamOperationInput
    from aws_sdk_bedrock_runtime.models import InvokeModelWithBidirectionalStreamInputChunk, BidirectionalInputPayloadPart
    from aws_sdk_bedrock_runtime.config import Config, HTTPAuthSchemeResolver, SigV4AuthScheme
    from smithy_aws_core.identity import EnvironmentCredentialsResolver
    SONIC_AVAILABLE = True
except ImportError:
    print("VOICE_LOG:Nova Sonic SDK not available (requires Python 3.12+), using fallback STT", file=sys.stderr)

SILERO_AVAILABLE = False
_silero_model = None
try:
    import torch
    from silero_vad import load_silero_vad
    SILERO_AVAILABLE = True
except ImportError:
    print("VOICE_LOG:Silero VAD not available, using RMS fallback", file=sys.stderr)

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_SIZE = 1024
VAD_CHUNK_SIZE = 512


def _get_silero_model():
    global _silero_model
    if _silero_model is None and SILERO_AVAILABLE:
        _silero_model = load_silero_vad()
    return _silero_model


class SimpleNovaSonic:
    def __init__(self, model_id='amazon.nova-2-sonic-v1:0', region='us-east-1'):
        self.model_id = model_id
        self.region = region
        self.client = None
        self.stream = None
        self.response = None
        self.is_active = False
        self.prompt_name = str(uuid.uuid4())
        self.content_name = str(uuid.uuid4())
        self.audio_content_name = str(uuid.uuid4())
        self.audio_queue = asyncio.Queue()
        self.display_assistant_text = False
        self.role = None
        self.transcription = ""
        self.transcription_complete = False

    def _initialize_client(self):
        config = Config(
            endpoint_uri=f"https://bedrock-runtime.{self.region}.amazonaws.com",
            region=self.region,
            aws_credentials_identity_resolver=EnvironmentCredentialsResolver(),
            auth_scheme_resolver=HTTPAuthSchemeResolver(),
            auth_schemes={"aws.auth#sigv4": SigV4AuthScheme(service="bedrock")}
        )
        self.client = BedrockRuntimeClient(config=config)

    async def send_event(self, event_json):
        event = InvokeModelWithBidirectionalStreamInputChunk(
            value=BidirectionalInputPayloadPart(bytes_=event_json.encode('utf-8'))
        )
        await self.stream.input_stream.send(event)

    async def start_session(self):
        if not self.client:
            self._initialize_client()

        self.stream = await self.client.invoke_model_with_bidirectional_stream(
            InvokeModelWithBidirectionalStreamOperationInput(model_id=self.model_id)
        )
        self.is_active = True

        session_start = f'''
        {{
          "event": {{
            "sessionStart": {{
              "inferenceConfiguration": {{
                "maxTokens": 1024,
                "topP": 0.9,
                "temperature": 0.7
              }},
              "turnDetectionConfiguration": {{
                "endpointingSensitivity": "LOW"
              }}
            }}
          }}
        }}
        '''
        await self.send_event(session_start)

        prompt_start = f'''
        {{
          "event": {{
            "promptStart": {{
              "promptName": "{self.prompt_name}",
              "textOutputConfiguration": {{
                "mediaType": "text/plain"
              }},
              "audioOutputConfiguration": {{
                "mediaType": "audio/lpcm",
                "sampleRateHertz": 24000,
                "sampleSizeBits": 16,
                "channelCount": 1,
                "voiceId": "tiffany",
                "encoding": "base64",
                "audioType": "SPEECH"
              }}
            }}
          }}
        }}
        '''
        await self.send_event(prompt_start)

        text_content_start = f'''
        {{
            "event": {{
                "contentStart": {{
                    "promptName": "{self.prompt_name}",
                    "contentName": "{self.content_name}",
                    "type": "TEXT",
                    "interactive": true,
                    "role": "SYSTEM",
                    "textInputConfiguration": {{
                        "mediaType": "text/plain"
                    }}
                }}
            }}
        }}
        '''
        await self.send_event(text_content_start)

        system_prompt = "You are NovaAssist, a voice AI that controls a computer. Listen to what the user says and repeat it back as a short confirmation under 5 words."

        text_input = f'''
        {{
            "event": {{
                "textInput": {{
                    "promptName": "{self.prompt_name}",
                    "contentName": "{self.content_name}",
                    "content": "{system_prompt}"
                }}
            }}
        }}
        '''
        await self.send_event(text_input)

        text_content_end = f'''
        {{
            "event": {{
                "contentEnd": {{
                    "promptName": "{self.prompt_name}",
                    "contentName": "{self.content_name}"
                }}
            }}
        }}
        '''
        await self.send_event(text_content_end)

        self.response = asyncio.create_task(self._process_responses())

    async def start_audio_input(self):
        audio_content_start = f'''
        {{
            "event": {{
                "contentStart": {{
                    "promptName": "{self.prompt_name}",
                    "contentName": "{self.audio_content_name}",
                    "type": "AUDIO",
                    "interactive": true,
                    "role": "USER",
                    "audioInputConfiguration": {{
                        "mediaType": "audio/lpcm",
                        "sampleRateHertz": 16000,
                        "sampleSizeBits": 16,
                        "channelCount": 1,
                        "audioType": "SPEECH",
                        "encoding": "base64"
                    }}
                }}
            }}
        }}
        '''
        await self.send_event(audio_content_start)

    async def send_audio_chunk(self, audio_bytes):
        if not self.is_active:
            return
        blob = base64.b64encode(audio_bytes)
        audio_event = f'''
        {{
            "event": {{
                "audioInput": {{
                    "promptName": "{self.prompt_name}",
                    "contentName": "{self.audio_content_name}",
                    "content": "{blob.decode('utf-8')}"
                }}
            }}
        }}
        '''
        await self.send_event(audio_event)

    async def end_audio_input(self):
        audio_content_end = f'''
        {{
            "event": {{
                "contentEnd": {{
                    "promptName": "{self.prompt_name}",
                    "contentName": "{self.audio_content_name}"
                }}
            }}
        }}
        '''
        await self.send_event(audio_content_end)

    async def end_session(self):
        if not self.is_active:
            return
        prompt_end = f'''
        {{
            "event": {{
                "promptEnd": {{
                    "promptName": "{self.prompt_name}"
                }}
            }}
        }}
        '''
        await self.send_event(prompt_end)
        session_end = '{"event": {"sessionEnd": {}}}'
        await self.send_event(session_end)
        await self.stream.input_stream.close()

    async def _process_responses(self):
        try:
            while self.is_active:
                output = await self.stream.await_output()
                result = await output[1].receive()
                if result.value and result.value.bytes_:
                    response_data = result.value.bytes_.decode('utf-8')
                    json_data = json.loads(response_data)
                    if 'event' in json_data:
                        if 'contentStart' in json_data['event']:
                            content_start = json_data['event']['contentStart']
                            self.role = content_start.get('role', '')
                            if 'additionalModelFields' in content_start:
                                additional_fields = json.loads(content_start['additionalModelFields'])
                                if additional_fields.get('generationStage') == 'SPECULATIVE':
                                    self.display_assistant_text = True
                                else:
                                    self.display_assistant_text = False
                        elif 'contentEnd' in json_data['event']:
                            if self.role == "USER" and self.transcription:
                                self.transcription_complete = True
                        elif 'textOutput' in json_data['event']:
                            text = json_data['event']['textOutput']['content']
                            if self.role == "USER":
                                self.transcription += text
                                print(f"VOICE_LOG:Heard: {text}", file=sys.stderr)
                            elif self.role == "ASSISTANT":
                                print(f"VOICE_LOG:Sonic: {text}", file=sys.stderr)
                        elif 'audioOutput' in json_data['event']:
                            audio_content = json_data['event']['audioOutput']['content']
                            audio_bytes = base64.b64decode(audio_content)
                            await self.audio_queue.put(audio_bytes)
        except Exception as e:
            if self.is_active:
                print(f"VOICE_LOG:Response error: {e}", file=sys.stderr)

    async def drain_audio_queue(self):
        """Drain audio queue without playing -- STT-only mode."""
        try:
            while self.is_active:
                try:
                    await asyncio.wait_for(self.audio_queue.get(), timeout=0.1)
                except asyncio.TimeoutError:
                    continue
        except Exception:
            pass

    async def play_audio(self):
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=OUTPUT_SAMPLE_RATE, output=True)
        try:
            while self.is_active:
                audio_data = await self.audio_queue.get()
                stream.write(audio_data)
        except Exception:
            pass
        finally:
            stream.stop_stream()
            stream.close()
            p.terminate()

    async def capture_audio(self):
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=INPUT_SAMPLE_RATE, input=True, frames_per_buffer=CHUNK_SIZE)
        print("VOICE_LOG:Speak now... Press Enter to stop.", file=sys.stderr)
        await self.start_audio_input()
        try:
            while self.is_active:
                audio_data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                await self.send_audio_chunk(audio_data)
                await asyncio.sleep(0.01)
        except Exception as e:
            print(f"VOICE_LOG:Capture error: {e}", file=sys.stderr)
        finally:
            stream.stop_stream()
            stream.close()
            p.terminate()
            await self.end_audio_input()

    async def capture_timed(self, duration=8):
        """Capture audio for a fixed duration."""
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=INPUT_SAMPLE_RATE, input=True, frames_per_buffer=CHUNK_SIZE)
        print("VOICE_LOG:Listening...", file=sys.stderr)
        await self.start_audio_input()
        total = int(INPUT_SAMPLE_RATE / CHUNK_SIZE * duration)
        for _ in range(total):
            if not self.is_active:
                break
            audio_data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            await self.send_audio_chunk(audio_data)
            await asyncio.sleep(0.01)
        stream.stop_stream()
        stream.close()
        p.terminate()
        print("VOICE_LOG:Done", file=sys.stderr)
        await self.end_audio_input()

    async def capture_smart(self, max_duration=15, silence_threshold=500, silence_timeout=1.5):
        """Capture audio with VAD-based end-of-speech detection."""
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=INPUT_SAMPLE_RATE, input=True, frames_per_buffer=CHUNK_SIZE)
        print("VOICE_LOG:Listening (smart mode)...", file=sys.stderr)
        await self.start_audio_input()

        vad_model = _get_silero_model()
        use_vad = vad_model is not None

        total_chunks = int(INPUT_SAMPLE_RATE / CHUNK_SIZE * max_duration)
        speech_detected = False
        silent_chunks = 0
        chunks_per_second = INPUT_SAMPLE_RATE / CHUNK_SIZE
        silence_chunk_limit = int(silence_timeout * chunks_per_second)

        vad_buffer = b''
        vad_silent_ms = 0
        vad_speech_detected = False
        vad_frame_bytes = VAD_CHUNK_SIZE * 2  # 16-bit samples

        for i in range(total_chunks):
            if not self.is_active:
                break
            audio_data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            await self.send_audio_chunk(audio_data)

            if use_vad:
                vad_buffer += audio_data
                while len(vad_buffer) >= vad_frame_bytes:
                    frame = vad_buffer[:vad_frame_bytes]
                    vad_buffer = vad_buffer[vad_frame_bytes:]
                    samples = _struct.unpack(f"<{VAD_CHUNK_SIZE}h", frame)
                    tensor = torch.FloatTensor(samples) / 32768.0
                    speech_prob = vad_model(tensor, INPUT_SAMPLE_RATE).item()
                    frame_ms = VAD_CHUNK_SIZE * 1000 / INPUT_SAMPLE_RATE

                    if speech_prob > 0.5:
                        vad_speech_detected = True
                        vad_silent_ms = 0
                    elif vad_speech_detected:
                        vad_silent_ms += frame_ms
                        if vad_silent_ms >= 750:
                            print(f"VOICE_LOG:VAD silence detected (750ms), stopping capture", file=sys.stderr)
                            stream.stop_stream()
                            stream.close()
                            p.terminate()
                            await self.end_audio_input()
                            return
            else:
                samples = _struct.unpack(f"<{CHUNK_SIZE}h", audio_data)
                rms = (sum(s * s for s in samples) / CHUNK_SIZE) ** 0.5
                if rms > silence_threshold:
                    speech_detected = True
                    silent_chunks = 0
                elif speech_detected:
                    silent_chunks += 1
                    if silent_chunks >= silence_chunk_limit:
                        print(f"VOICE_LOG:RMS silence detected ({silence_timeout}s), stopping capture", file=sys.stderr)
                        break

            await asyncio.sleep(0.01)

        stream.stop_stream()
        stream.close()
        p.terminate()
        print("VOICE_LOG:Done (smart)", file=sys.stderr)
        await self.end_audio_input()


async def run_interactive():
    """Interactive mode -- continuous conversation, press Enter to stop."""
    nova = SimpleNovaSonic()
    await nova.start_session()
    playback_task = asyncio.create_task(nova.play_audio())
    capture_task = asyncio.create_task(nova.capture_audio())
    await asyncio.get_event_loop().run_in_executor(None, input)
    nova.is_active = False
    for task in [playback_task, capture_task]:
        if not task.done():
            task.cancel()
    await asyncio.gather(playback_task, capture_task, return_exceptions=True)
    if nova.response and not nova.response.done():
        nova.response.cancel()
    await nova.end_session()
    return nova.transcription


async def _wait_for_transcription(nova, max_wait=0.5):
    """Poll for transcription completion instead of hardcoded sleep."""
    elapsed = 0
    while elapsed < max_wait and not nova.transcription_complete:
        await asyncio.sleep(0.05)
        elapsed += 0.05


async def run_listen(duration=8):
    """Listen for fixed duration, return transcription. STT-only -- no audio playback."""
    nova = SimpleNovaSonic()
    await nova.start_session()
    drain_task = asyncio.create_task(nova.drain_audio_queue())
    await nova.capture_timed(duration=duration)
    await _wait_for_transcription(nova)
    nova.is_active = False
    drain_task.cancel()
    await asyncio.gather(drain_task, return_exceptions=True)
    if nova.response and not nova.response.done():
        nova.response.cancel()
    try:
        await nova.end_session()
    except:
        pass
    return nova.transcription


async def run_listen_smart(max_duration=15, silence_timeout=1.5):
    """Listen with silence detection, STT-only -- no audio playback."""
    nova = SimpleNovaSonic()
    await nova.start_session()
    drain_task = asyncio.create_task(nova.drain_audio_queue())
    await nova.capture_smart(max_duration=max_duration, silence_timeout=silence_timeout)
    await _wait_for_transcription(nova)
    nova.is_active = False
    drain_task.cancel()
    await asyncio.gather(drain_task, return_exceptions=True)
    if nova.response and not nova.response.done():
        nova.response.cancel()
    try:
        await nova.end_session()
    except:
        pass
    return nova.transcription


def speak_text(text):
    subprocess.run(["say", "-v", "Samantha", "-r", "185", text], capture_output=True)


def _has_aws_credentials():
    key = os.environ.get('AWS_ACCESS_KEY_ID', '').strip()
    secret = os.environ.get('AWS_SECRET_ACCESS_KEY', '').strip()
    return bool(key) and bool(secret)


async def _run_with_timeout(coro, timeout_sec):
    return await asyncio.wait_for(coro, timeout=timeout_sec)


def fallback_listen(duration=6):
    try:
        import speech_recognition as sr
        r = sr.Recognizer()
        with sr.Microphone(sample_rate=16000) as src:
            r.adjust_for_ambient_noise(src, duration=0.5)
            print("VOICE_LOG:Listening (fallback)...", file=sys.stderr)
            audio = r.listen(src, timeout=duration, phrase_time_limit=duration)
        text = r.recognize_google(audio)
        print(f"VOICE_LOG:Fallback got: {text}", file=sys.stderr)
        return text
    except Exception as e:
        print(f"VOICE_LOG:Fallback error: {e}", file=sys.stderr)
        return ""


async def run_daemon():
    """Long-running daemon mode: read commands from stdin, write results to stdout."""
    print("VOICE_DAEMON_READY", flush=True)
    print("VOICE_LOG:Daemon started, waiting for commands...", file=sys.stderr)

    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        parts = line.split()
        cmd = parts[0].upper()

        use_sonic = SONIC_AVAILABLE and _has_aws_credentials()

        if cmd == "LISTEN":
            dur = int(parts[1]) if len(parts) > 1 else 8
            if use_sonic:
                try:
                    txt = await _run_with_timeout(run_listen(dur), timeout_sec=dur + 10)
                    print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic"}), flush=True)
                except Exception as e:
                    print(f"VOICE_LOG:Sonic failed: {e}, using fallback", file=sys.stderr)
                    txt = fallback_listen(dur)
                    print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}), flush=True)
            else:
                txt = fallback_listen(dur)
                print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}), flush=True)

        elif cmd == "LISTEN_SMART":
            max_dur = int(parts[1]) if len(parts) > 1 else 15
            silence_sec = float(parts[2]) if len(parts) > 2 else 1.5
            if use_sonic:
                try:
                    txt = await _run_with_timeout(run_listen_smart(max_dur, silence_sec), timeout_sec=max_dur + 10)
                    print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic-smart"}), flush=True)
                except Exception as e:
                    print(f"VOICE_LOG:Sonic smart failed: {e}, using fallback", file=sys.stderr)
                    txt = fallback_listen(max_dur)
                    print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}), flush=True)
            else:
                txt = fallback_listen(max_dur)
                print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}), flush=True)

        elif cmd == "QUIT":
            break
        else:
            print("VOICE_RESULT:" + json.dumps({"transcription": "", "error": f"Unknown command: {cmd}", "engine": "none"}), flush=True)

    print("VOICE_LOG:Daemon shutting down", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 voice_engine.py [listen|speak|listen_smart|interactive|daemon]")
        sys.exit(1)

    mode = sys.argv[1]

    use_sonic = SONIC_AVAILABLE and _has_aws_credentials()
    if not _has_aws_credentials():
        print("VOICE_LOG:No AWS credentials found, using fallback STT", file=sys.stderr)

    if mode == "daemon":
        asyncio.run(run_daemon())

    elif mode == "listen":
        dur = int(sys.argv[2]) if len(sys.argv) > 2 else 8
        if use_sonic:
            try:
                txt = asyncio.run(_run_with_timeout(run_listen(dur), timeout_sec=dur + 10))
                print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic"}))
            except Exception as e:
                print(f"VOICE_LOG:Sonic failed: {e}, using fallback", file=sys.stderr)
                txt = fallback_listen(dur)
                print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}))
        else:
            txt = fallback_listen(dur)
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}))

    elif mode == "speak":
        text = sys.argv[2] if len(sys.argv) > 2 else "Hello, I am Nova Assist."
        speak_text(text)
        print("VOICE_RESULT:" + json.dumps({"success": True, "engine": "macos-say"}))

    elif mode == "listen_smart":
        max_dur = int(sys.argv[2]) if len(sys.argv) > 2 else 15
        silence_sec = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5
        if use_sonic:
            try:
                txt = asyncio.run(_run_with_timeout(run_listen_smart(max_dur, silence_sec), timeout_sec=max_dur + 10))
                print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic-smart"}))
            except Exception as e:
                print(f"VOICE_LOG:Sonic smart failed: {e}, using fallback", file=sys.stderr)
                txt = fallback_listen(max_dur)
                print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}))
        else:
            txt = fallback_listen(max_dur)
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}))

    elif mode == "interactive":
        if not SONIC_AVAILABLE:
            print("VOICE_RESULT:" + json.dumps({"transcription": "", "error": "Nova Sonic requires Python 3.12+", "engine": "none"}))
        else:
            print("Nova 2 Sonic Interactive Mode. Press Enter to stop.")
            txt = asyncio.run(run_interactive())
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic"}))
