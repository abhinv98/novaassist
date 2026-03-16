"""
NovaAssist Voice Engine — Based exactly on AWS official SimpleNovaSonic sample
"""
import os, sys, asyncio, base64, json, uuid, subprocess, pyaudio

from aws_sdk_bedrock_runtime.client import BedrockRuntimeClient, InvokeModelWithBidirectionalStreamOperationInput
from aws_sdk_bedrock_runtime.models import InvokeModelWithBidirectionalStreamInputChunk, BidirectionalInputPayloadPart
from aws_sdk_bedrock_runtime.config import Config, HTTPAuthSchemeResolver, SigV4AuthScheme
from smithy_aws_core.identity import EnvironmentCredentialsResolver

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_SIZE = 1024


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

        # Start processing responses immediately
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
                        elif 'textOutput' in json_data['event']:
                            text = json_data['event']['textOutput']['content']
                            if self.role == "USER":
                                self.transcription += text
                                print(f"VOICE_LOG:📝 Heard: {text}", file=sys.stderr)
                            elif self.role == "ASSISTANT":
                                print(f"VOICE_LOG:🤖 Sonic: {text}", file=sys.stderr)
                        elif 'audioOutput' in json_data['event']:
                            audio_content = json_data['event']['audioOutput']['content']
                            audio_bytes = base64.b64decode(audio_content)
                            await self.audio_queue.put(audio_bytes)
        except Exception as e:
            if self.is_active:
                print(f"VOICE_LOG:Response error: {e}", file=sys.stderr)

    async def play_audio(self):
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=OUTPUT_SAMPLE_RATE, output=True)
        try:
            while self.is_active:
                audio_data = await self.audio_queue.get()
                stream.write(audio_data)
        except Exception as e:
            pass
        finally:
            stream.stop_stream()
            stream.close()
            p.terminate()

    async def capture_audio(self):
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=INPUT_SAMPLE_RATE, input=True, frames_per_buffer=CHUNK_SIZE)
        print("VOICE_LOG:🎙️ Speak now... Press Enter to stop.", file=sys.stderr)
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
        """Capture audio for a fixed duration instead of until Enter."""
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=INPUT_SAMPLE_RATE, input=True, frames_per_buffer=CHUNK_SIZE)
        print("VOICE_LOG:🎙️ Listening...", file=sys.stderr)
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
        print("VOICE_LOG:✅ Done", file=sys.stderr)
        await self.end_audio_input()

    async def capture_smart(self, max_duration=15, silence_threshold=500, silence_timeout=3.0):
        """Capture audio with silence detection — stops early when the user stops speaking."""
        import struct as _struct
        p = pyaudio.PyAudio()
        stream = p.open(format=FORMAT, channels=CHANNELS, rate=INPUT_SAMPLE_RATE, input=True, frames_per_buffer=CHUNK_SIZE)
        print("VOICE_LOG:🎙️ Listening (smart mode)...", file=sys.stderr)
        await self.start_audio_input()

        total_chunks = int(INPUT_SAMPLE_RATE / CHUNK_SIZE * max_duration)
        speech_detected = False
        silent_chunks = 0
        chunks_per_second = INPUT_SAMPLE_RATE / CHUNK_SIZE
        silence_chunk_limit = int(silence_timeout * chunks_per_second)

        for i in range(total_chunks):
            if not self.is_active:
                break
            audio_data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            await self.send_audio_chunk(audio_data)

            samples = _struct.unpack(f"<{CHUNK_SIZE}h", audio_data)
            rms = (sum(s * s for s in samples) / CHUNK_SIZE) ** 0.5

            if rms > silence_threshold:
                speech_detected = True
                silent_chunks = 0
            elif speech_detected:
                silent_chunks += 1
                if silent_chunks >= silence_chunk_limit:
                    print(f"VOICE_LOG:🔇 Silence detected after speech ({silence_timeout}s), stopping capture", file=sys.stderr)
                    break

            await asyncio.sleep(0.01)

        stream.stop_stream()
        stream.close()
        p.terminate()
        print("VOICE_LOG:✅ Done (smart)", file=sys.stderr)
        await self.end_audio_input()


async def run_interactive():
    """Interactive mode — continuous conversation, press Enter to stop."""
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


async def run_listen(duration=8):
    """Listen for fixed duration, return transcription."""
    nova = SimpleNovaSonic()
    await nova.start_session()
    playback_task = asyncio.create_task(nova.play_audio())
    await nova.capture_timed(duration=duration)
    # Wait for Sonic to finish responding
    await asyncio.sleep(3)
    nova.is_active = False
    playback_task.cancel()
    await asyncio.gather(playback_task, return_exceptions=True)
    if nova.response and not nova.response.done():
        nova.response.cancel()
    try:
        await nova.end_session()
    except:
        pass
    return nova.transcription


async def run_listen_smart(max_duration=15, silence_timeout=3.0):
    """Listen with silence detection — exits early when the user stops speaking."""
    nova = SimpleNovaSonic()
    await nova.start_session()
    playback_task = asyncio.create_task(nova.play_audio())
    await nova.capture_smart(max_duration=max_duration, silence_timeout=silence_timeout)
    await asyncio.sleep(3)
    nova.is_active = False
    playback_task.cancel()
    await asyncio.gather(playback_task, return_exceptions=True)
    if nova.response and not nova.response.done():
        nova.response.cancel()
    try:
        await nova.end_session()
    except:
        pass
    return nova.transcription


def speak_text(text):
    subprocess.run(["say", "-v", "Samantha", "-r", "185", text], capture_output=True)


def fallback_listen(duration=6):
    try:
        import speech_recognition as sr
        r = sr.Recognizer()
        with sr.Microphone(sample_rate=16000) as src:
            r.adjust_for_ambient_noise(src, duration=0.5)
            print("VOICE_LOG:🎙️ Listening (fallback)...", file=sys.stderr)
            audio = r.listen(src, timeout=duration, phrase_time_limit=duration)
        return r.recognize_google(audio)
    except:
        return ""


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 voice_engine.py [listen|speak|interactive] [text/duration]")
        sys.exit(1)

    mode = sys.argv[1]

    if mode == "listen":
        dur = int(sys.argv[2]) if len(sys.argv) > 2 else 8
        try:
            txt = asyncio.run(run_listen(dur))
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic"}))
        except Exception as e:
            print(f"VOICE_LOG:Sonic failed: {e}, using fallback", file=sys.stderr)
            txt = fallback_listen(dur)
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}))

    elif mode == "speak":
        text = sys.argv[2] if len(sys.argv) > 2 else "Hello, I am Nova Assist."
        speak_text(text)
        print("VOICE_RESULT:" + json.dumps({"success": True, "engine": "macos-say"}))

    elif mode == "listen_smart":
        max_dur = int(sys.argv[2]) if len(sys.argv) > 2 else 15
        silence_sec = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
        try:
            txt = asyncio.run(run_listen_smart(max_dur, silence_sec))
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic-smart"}))
        except Exception as e:
            print(f"VOICE_LOG:Sonic smart failed: {e}, using fallback", file=sys.stderr)
            txt = fallback_listen(max_dur)
            print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "fallback"}))

    elif mode == "interactive":
        print("Nova 2 Sonic Interactive Mode. Press Enter to stop.")
        txt = asyncio.run(run_interactive())
        print("VOICE_RESULT:" + json.dumps({"transcription": txt, "error": None, "engine": "nova-sonic"}))
