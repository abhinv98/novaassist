"""
NovaAssist Wake Word Daemon — Always-on background listener using Picovoice Porcupine.
Listens for a wake word, prints WAKE_WORD_DETECTED to stdout, then pauses until
it receives RESUME on stdin from the Electron app.

Usage:
  python3 wake_word.py --access-key YOUR_KEY [--keyword jarvis]

Environment variable alternative:
  PICOVOICE_ACCESS_KEY=YOUR_KEY python3 wake_word.py
"""
import sys, os, argparse, struct, time

import pvporcupine
import pyaudio

def main():
    parser = argparse.ArgumentParser(description="NovaAssist Wake Word Daemon")
    parser.add_argument("--access-key", default=os.environ.get("PICOVOICE_ACCESS_KEY", ""),
                        help="Picovoice access key (or set PICOVOICE_ACCESS_KEY env var)")
    parser.add_argument("--keyword", default="jarvis",
                        help="Built-in wake word to listen for (default: jarvis)")
    parser.add_argument("--sensitivity", type=float, default=0.7,
                        help="Detection sensitivity 0.0-1.0 (default: 0.7)")
    args = parser.parse_args()

    access_key = args.access_key
    if not access_key:
        print("WAKE_WORD_ERROR:No Picovoice access key provided. Set PICOVOICE_ACCESS_KEY or use --access-key", flush=True)
        sys.exit(1)

    keyword = args.keyword.lower()
    if keyword not in pvporcupine.KEYWORDS:
        print(f"WAKE_WORD_ERROR:Unknown keyword '{keyword}'. Available: {', '.join(sorted(pvporcupine.KEYWORDS))}", flush=True)
        sys.exit(1)

    try:
        porcupine = pvporcupine.create(
            access_key=access_key,
            keywords=[keyword],
            sensitivities=[args.sensitivity],
        )
    except pvporcupine.PorcupineActivationError as e:
        print(f"WAKE_WORD_ERROR:Invalid access key: {e}", flush=True)
        sys.exit(1)
    except Exception as e:
        print(f"WAKE_WORD_ERROR:Failed to initialize Porcupine: {e}", flush=True)
        sys.exit(1)

    pa = pyaudio.PyAudio()
    audio_stream = pa.open(
        rate=porcupine.sample_rate,
        channels=1,
        format=pyaudio.paInt16,
        input=True,
        frames_per_buffer=porcupine.frame_length,
    )

    print(f"WAKE_WORD_READY:Listening for '{keyword}' (sensitivity={args.sensitivity})", flush=True)

    try:
        while True:
            pcm = audio_stream.read(porcupine.frame_length, exception_on_overflow=False)
            pcm_unpacked = struct.unpack_from("h" * porcupine.frame_length, pcm)

            keyword_index = porcupine.process(pcm_unpacked)

            if keyword_index >= 0:
                print("WAKE_WORD_DETECTED", flush=True)

                audio_stream.stop_stream()
                try:
                    while True:
                        line = sys.stdin.readline().strip()
                        if line == "RESUME":
                            audio_stream.start_stream()
                            print(f"WAKE_WORD_READY:Resumed listening for '{keyword}'", flush=True)
                            break
                        if not line:
                            time.sleep(0.1)
                except EOFError:
                    break

    except KeyboardInterrupt:
        pass
    finally:
        audio_stream.stop_stream()
        audio_stream.close()
        pa.terminate()
        porcupine.delete()
        print("WAKE_WORD_STOPPED", flush=True)


if __name__ == "__main__":
    main()
