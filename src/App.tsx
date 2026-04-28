import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  base64ToWavBlob,
  float32SamplesToWavBlob,
  getBestRecordingMimeType,
  recordedBlobToWavBlob,
  wavBlobToBase64,
} from "./audio";
import { GEMINI_MODEL, sendGeminiTextChat } from "./gemini";
import { createQrSvgDataUrl } from "./qr";
import {
  DEFAULT_SPEACHES_BASE_URL,
  DEFAULT_SYSTEM_PROMPT,
  OLLAMA_MODEL,
  STT_MODEL,
  TTS_MODEL,
  TTS_VOICE,
  getDefaultSpeachesBaseUrl,
  sendAudioChat,
  synthesizeSpeech,
  transcribeAudio,
} from "./speaches";

type LlmProvider = "local" | "gemini";
type RecordingStatus = "idle" | "requesting microphone" | "recording" | "stopping";
type RequestStatus =
  | "idle"
  | "converting audio"
  | "transcribing audio"
  | "sending to Speaches"
  | "calling Gemini"
  | "synthesizing speech"
  | "playing response"
  | "complete"
  | "error";
type WakeStatus =
  | "off"
  | "requesting microphone"
  | "listening"
  | "hearing speech"
  | "awaiting command"
  | "checking speech"
  | "wake word detected"
  | "paused"
  | "error";
type VoiceSignal = {
  level: number;
  threshold: number;
  noise: number;
};
type VisualizerMode =
  | "idle"
  | "listening"
  | "hearing"
  | "recording"
  | "thinking"
  | "speaking"
  | "answered";

const DEFAULT_WAKE_WORD = "hey assistant";
const SYSTEM_PROMPT_STORAGE_KEY = "speaches-system-prompt";
const LEGACY_TURKISH_REPLY_PROMPT_MARKER = "If I speak Turkish, reply in Turkish";
const LLM_PROVIDER_STORAGE_KEY = "speaches-llm-provider";
const GEMINI_API_KEY_STORAGE_KEY = "speaches-gemini-api-key";
const WAKE_RESTART_DELAY_MS = 300;
const WAKE_RESUME_AFTER_RESPONSE_MS = 1600;
const WAKE_PREROLL_MS = 100;
const WAKE_CALIBRATION_MS = 350;
const WAKE_MIN_SPEECH_MS = 350;
const WAKE_END_SILENCE_MS = 900;
const WAKE_MAX_UTTERANCE_MS = 15000;
const WAKE_COMMAND_TIMEOUT_MS = 8000;
const WAKE_MIN_START_RMS = 0.012;
const WAKE_MIN_CONTINUE_RMS = 0.007;
const WAKE_START_NOISE_MULTIPLIER = 2.6;
const WAKE_CONTINUE_NOISE_MULTIPLIER = 1.8;
const WAKE_INITIAL_NOISE_FLOOR = 0.004;
const WAKE_ACTIVITY_UPDATE_MS = 250;
const WAKE_WATCHDOG_MS = 1500;
const WAKE_AUDIO_STALL_MS = 4500;
const INITIAL_VOICE_SIGNAL: VoiceSignal = {
  level: 0,
  threshold: WAKE_MIN_START_RMS,
  noise: WAKE_INITIAL_NOISE_FLOOR,
};
const WAVE_BAR_WEIGHTS = [
  0.32, 0.46, 0.28, 0.6, 0.5, 0.74, 0.42, 0.86, 0.58, 0.95, 0.7, 0.82, 0.54, 1, 0.76, 0.88,
  0.62, 0.46, 0.72, 0.92, 0.66, 0.84, 0.5, 0.76, 0.44, 0.62, 0.36, 0.52,
];
type BrowserWindowWithAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function getInitialSystemPrompt() {
  try {
    const storedPrompt = window.localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY);
    const trimmedPrompt = storedPrompt?.trim();

    if (!trimmedPrompt || trimmedPrompt.includes(LEGACY_TURKISH_REPLY_PROMPT_MARKER)) {
      return DEFAULT_SYSTEM_PROMPT;
    }

    return trimmedPrompt;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

function getInitialLlmProvider(): LlmProvider {
  try {
    return window.localStorage.getItem(LLM_PROVIDER_STORAGE_KEY) === "gemini" ? "gemini" : "local";
  } catch {
    return "local";
  }
}

function getInitialGeminiApiKey() {
  try {
    return window.localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getPhoneAccessUrl() {
  const lanAddress = typeof __LAN_ADDRESS__ === "string" ? __LAN_ADDRESS__ : "";

  if (!lanAddress) {
    return "";
  }

  const port = window.location.port ? `:${window.location.port}` : "";
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";

  return `${protocol}//${lanAddress}${port}`;
}

function App() {
  const [baseUrl, setBaseUrl] = useState(getDefaultSpeachesBaseUrl);
  const [wakeWord, setWakeWord] = useState(DEFAULT_WAKE_WORD);
  const [systemPrompt, setSystemPrompt] = useState(getInitialSystemPrompt);
  const [llmProvider, setLlmProvider] = useState<LlmProvider>(getInitialLlmProvider);
  const [geminiApiKey, setGeminiApiKey] = useState(getInitialGeminiApiKey);
  const [showLocalInfo, setShowLocalInfo] = useState(false);
  const [showPhoneQr, setShowPhoneQr] = useState(false);
  const [phoneCopyStatus, setPhoneCopyStatus] = useState("");
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [wakeStatus, setWakeStatus] = useState<WakeStatus>("off");
  const [wakeTranscript, setWakeTranscript] = useState("");
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>("idle");
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [assistantText, setAssistantText] = useState("");
  const [transcriptionText, setTranscriptionText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [assistantAudioUrl, setAssistantAudioUrl] = useState("");
  const [assistantNeedsTap, setAssistantNeedsTap] = useState(false);
  const [rawResponse, setRawResponse] = useState("");
  const [voiceActivity, setVoiceActivity] = useState("");
  const [voiceSignal, setVoiceSignal] = useState<VoiceSignal>(INITIAL_VOICE_SIGNAL);
  const [lastIgnoredSpeech, setLastIgnoredSpeech] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const assistantOutputAudioContextRef = useRef<AudioContext | null>(null);
  const assistantOutputSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const assistantOutputAnalyserRef = useRef<AnalyserNode | null>(null);
  const assistantOutputBufferSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const assistantOutputFrameRef = useRef<number | undefined>(undefined);
  const assistantOutputDataRef = useRef<Uint8Array | null>(null);
  const assistantPlaybackAudioRef = useRef<HTMLAudioElement | null>(null);
  const assistantPlaybackUnlockedRef = useRef(false);
  const assistantPlaybackUnlockPromiseRef = useRef<Promise<void> | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const assistantAudioUrlRef = useRef("");
  const assistantAudioBlobRef = useRef<Blob | null>(null);
  const baseUrlRef = useRef(baseUrl);
  const wakeWordRef = useRef(wakeWord);
  const wakeEnabledRef = useRef(false);
  const wakeStreamRef = useRef<MediaStream | null>(null);
  const wakeAudioContextRef = useRef<AudioContext | null>(null);
  const wakeSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wakeProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const wakePreRollChunksRef = useRef<Float32Array[]>([]);
  const wakePreRollSampleCountRef = useRef(0);
  const wakeCalibrationSampleCountRef = useRef(0);
  const wakeSampleChunksRef = useRef<Float32Array[]>([]);
  const wakeSampleCountRef = useRef(0);
  const wakeSilentSampleCountRef = useRef(0);
  const wakeVoiceSampleCountRef = useRef(0);
  const wakeSpeechStartedRef = useRef(false);
  const wakeFinishingRef = useRef(false);
  const wakeRestartTimerRef = useRef<number | undefined>(undefined);
  const wakeWatchdogTimerRef = useRef<number | undefined>(undefined);
  const wakeLastActivityUpdateRef = useRef(0);
  const wakeLastAudioProcessAtRef = useRef(0);
  const wakeRestartingRef = useRef(false);
  const wakeNoiseFloorRef = useRef(WAKE_INITIAL_NOISE_FLOOR);
  const wakeCommandArmedRef = useRef(false);
  const wakeCommandArmedAtRef = useRef(0);
  const assistantBusyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    assistantAudioUrlRef.current = assistantAudioUrl;
  }, [assistantAudioUrl]);

  useEffect(() => {
    baseUrlRef.current = baseUrl;
  }, [baseUrl]);

  useEffect(() => {
    wakeWordRef.current = wakeWord;
  }, [wakeWord]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, systemPrompt);
    } catch {
      // The prompt still works for the current session when storage is unavailable.
    }
  }, [systemPrompt]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LLM_PROVIDER_STORAGE_KEY, llmProvider);
    } catch {
      // Provider selection still works for the current session when storage is unavailable.
    }
  }, [llmProvider]);

  useEffect(() => {
    try {
      window.localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, geminiApiKey);
    } catch {
      // API key still works for the current session when storage is unavailable.
    }
  }, [geminiApiKey]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopWakeListening({ ignoreChunk: true });
      stopWakeWatchdog();
      stopMicrophoneTracks();
      stopAssistantOutputVisualization({ dispose: true });
      revokeAssistantAudioUrl();
    };
  }, []);

  const setAssistantPlaybackElement = useCallback((element: HTMLAudioElement | null) => {
    assistantPlaybackAudioRef.current = element;

    if (element) {
      element.preload = "auto";
      element.setAttribute("playsinline", "");
    }
  }, []);

  function unlockAssistantPlayback({ force = false }: { force?: boolean } = {}) {
    if (assistantPlaybackUnlockedRef.current && !force) {
      return Promise.resolve();
    }

    if (assistantPlaybackUnlockPromiseRef.current) {
      return assistantPlaybackUnlockPromiseRef.current;
    }

    const audio = assistantPlaybackAudioRef.current;

    if (!audio) {
      return Promise.resolve();
    }

    const previousSrc = audio.getAttribute("src") ?? "";
    const previousCurrentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

    assistantPlaybackUnlockPromiseRef.current = (async () => {
      let resumeAudioContext = Promise.resolve(false);

      try {
        const audioContext = getAssistantOutputAudioContext({ create: true });

        if (audioContext) {
          ensureAssistantOutputAnalyser(audioContext);
          primeAssistantAudioContext(audioContext);
          resumeAudioContext = audioContext
            .resume()
            .then(() => audioContext.state === "running")
            .catch(() => false);
        }
      } catch {
        resumeAudioContext = Promise.resolve(false);
      }

      let unlockElement = Promise.resolve(false);

      try {
        audio.src = createSilentWavDataUrl();
        audio.load();
        unlockElement = audio
          .play()
          .then(() => {
            audio.pause();
            return true;
          })
          .catch(() => false);
      } catch {
        unlockElement = Promise.resolve(false);
      }

      try {
        const [audioContextUnlocked, elementUnlocked] = await Promise.all([
          resumeAudioContext,
          unlockElement,
        ]);

        if (previousSrc) {
          audio.src = previousSrc;
          try {
            audio.currentTime = previousCurrentTime;
          } catch {
            // Some mobile browsers delay seeking until metadata loads.
          }
        } else {
          audio.removeAttribute("src");
          audio.load();
        }

        if (audioContextUnlocked || elementUnlocked) {
          assistantPlaybackUnlockedRef.current = true;
        }
      } finally {
        assistantPlaybackUnlockPromiseRef.current = null;
      }
    })();

    return assistantPlaybackUnlockPromiseRef.current;
  }

  async function startRecording() {
    void unlockAssistantPlayback();
    const microphoneError = getMicrophoneSupportError({ requireMediaRecorder: true });

    if (microphoneError) {
      setErrorMessage(microphoneError);
      return;
    }

    pauseWakeListening();
    resetConversationState();

    try {
      setRecordingStatus("requesting microphone");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const mimeType = getBestRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      startRecordingVisualization(stream);

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener(
        "stop",
        () => {
          void processRecording(new Blob(chunksRef.current, { type: recorder.mimeType }));
        },
        { once: true },
      );

      recorder.start();
      setRecordingStatus("recording");
    } catch (error) {
      stopMicrophoneTracks();
      setRecordingStatus("idle");
      setErrorMessage(formatError(error));
      resumeWakeIfEnabled();
    }
  }

  function stopRecording() {
    void unlockAssistantPlayback();
    const recorder = recorderRef.current;

    if (!recorder || recorder.state !== "recording") {
      return;
    }

    setRecordingStatus("stopping");
    recorder.stop();
  }

  async function enableWakeMode() {
    void unlockAssistantPlayback();
    const microphoneError = getMicrophoneSupportError({ requireMediaRecorder: false });

    if (microphoneError) {
      setErrorMessage(microphoneError);
      return;
    }

    wakeEnabledRef.current = true;
    wakeNoiseFloorRef.current = WAKE_INITIAL_NOISE_FLOOR;
    clearWakeCommand();
    setWakeEnabled(true);
    setWakeTranscript(`Say "${wakeWordRef.current}" to wake me.`);
    setLastIgnoredSpeech("");
    setVoiceActivity("Waiting for speech.");
    setVoiceSignal(INITIAL_VOICE_SIGNAL);
    setTranscriptionText("");
    setErrorMessage("");
    startWakeWatchdog();
    scheduleWakeListening(0);
  }

  function disableWakeMode() {
    wakeEnabledRef.current = false;
    clearWakeCommand();
    setWakeEnabled(false);
    setLastIgnoredSpeech("");
    setVoiceActivity("");
    setVoiceSignal(INITIAL_VOICE_SIGNAL);
    stopWakeWatchdog();
    stopWakeListening({ ignoreChunk: true, status: "off" });
  }

  async function processRecording(recordedBlob: Blob) {
    stopMicrophoneTracks();
    setRecordingStatus("idle");

    try {
      if (recordedBlob.size === 0) {
        throw new Error("No audio was recorded.");
      }

      setRequestStatus("converting audio");
      const wavBlob = await recordedBlobToWavBlob(recordedBlob);
      await submitWavToAssistant(wavBlob);
    } catch (error) {
      setRequestStatus("error");
      setErrorMessage(formatError(error));
    } finally {
      resumeWakeIfEnabled(WAKE_RESUME_AFTER_RESPONSE_MS);
    }
  }

  async function submitWavToAssistant(wavBlob: Blob, fallbackTranscription = "") {
    assistantBusyRef.current = true;

    try {
      const result =
        llmProvider === "gemini"
          ? await submitWavToGeminiAssistant(wavBlob, fallbackTranscription)
          : await submitWavToLocalAssistant(wavBlob, fallbackTranscription);

      setAssistantText(result.assistantText || "No assistant text was returned.");
      setTranscriptionText(result.transcriptionText || fallbackTranscription);
      setRawResponse(JSON.stringify(result.rawResponse, null, 2));

      if (result.assistantAudioBlob) {
        setRequestStatus("playing response");
        const audioUrl = URL.createObjectURL(result.assistantAudioBlob);
        assistantAudioBlobRef.current = result.assistantAudioBlob;
        setAssistantNeedsTap(false);
        setAssistantAudioUrl(audioUrl);

        try {
          await playAssistantAudioUrl(audioUrl, result.assistantAudioBlob);
        } catch {
          setAssistantNeedsTap(true);
          setErrorMessage("Autoplay was blocked. Tap Play response once.");
        }
      }

      setRequestStatus("complete");
    } finally {
      assistantBusyRef.current = false;
    }
  }

  async function playAssistantAudioUrl(audioUrl: string, audioBlob = assistantAudioBlobRef.current) {
    const audio = assistantPlaybackAudioRef.current;

    if (!audio) {
      throw new Error("Assistant audio element is not ready.");
    }

    audio.src = audioUrl;
    audio.currentTime = 0;
    await resumeAssistantOutputContextIfUnlocked();

    if (audioBlob && canPlayAssistantBlobWithAudioContext()) {
      try {
        audio.pause();
        await playAssistantBlobWithAudioContext(audioBlob);
        return;
      } catch {
        stopAssistantOutputVisualization();
      }
    }

    await playAudioToEnd(audio, {
      onBeforePlay: () => startAssistantOutputVisualization(audio),
      onDone: stopAssistantOutputVisualization,
    });
  }

  async function retryAssistantAudioPlayback() {
    if (!assistantAudioUrlRef.current) {
      return;
    }

    try {
      setErrorMessage("");
      setAssistantNeedsTap(false);
      setRequestStatus("playing response");
      await unlockAssistantPlayback({ force: true });
      await playAssistantAudioUrl(assistantAudioUrlRef.current, assistantAudioBlobRef.current);
      setRequestStatus("complete");
    } catch {
      setAssistantNeedsTap(true);
      setRequestStatus("complete");
      setErrorMessage("Autoplay is still blocked. Use the audio controls.");
    }
  }

  async function submitWavToLocalAssistant(wavBlob: Blob, fallbackTranscription = "") {
    setRequestStatus("sending to Speaches");
    const base64Wav = await wavBlobToBase64(wavBlob);
    const result = await sendAudioChat(
      baseUrlRef.current,
      base64Wav,
      wakeWordRef.current,
      systemPrompt,
    );

    return {
      assistantText: result.assistantText,
      assistantAudioBlob: result.assistantAudioBase64
        ? base64ToWavBlob(result.assistantAudioBase64)
        : null,
      transcriptionText: result.transcriptionText || fallbackTranscription,
      rawResponse: {
        provider: "local",
        speaches: result.rawResponse,
      },
    };
  }

  async function submitWavToGeminiAssistant(wavBlob: Blob, fallbackTranscription = "") {
    let transcript = fallbackTranscription.trim();

    if (!transcript) {
      setRequestStatus("transcribing audio");
      transcript = (await transcribeAudio(baseUrlRef.current, wavBlob)).trim();
    }

    if (!transcript) {
      throw new Error("No transcription was returned for Gemini mode.");
    }

    setRequestStatus("calling Gemini");
    const geminiResult = await sendGeminiTextChat({
      apiKey: geminiApiKey,
      model: GEMINI_MODEL,
      systemPrompt,
      transcript,
      wakeWord: wakeWordRef.current,
    });

    setRequestStatus("synthesizing speech");
    const assistantAudioBlob = await synthesizeSpeech(baseUrlRef.current, geminiResult.assistantText);

    return {
      assistantText: geminiResult.assistantText,
      assistantAudioBlob,
      transcriptionText: transcript,
      rawResponse: {
        provider: "gemini",
        transcription: transcript,
        model: GEMINI_MODEL,
        gemini: geminiResult.rawResponse,
        tts: {
          model: TTS_MODEL,
          voice: TTS_VOICE,
          format: "wav",
        },
      },
    };
  }

  async function startWakeListening() {
    if (!wakeEnabledRef.current) {
      return;
    }

    if (wakeStreamRef.current) {
      return;
    }

    if (assistantBusyRef.current || recorderRef.current || wakeFinishingRef.current) {
      scheduleWakeListening(500);
      return;
    }

    try {
      setWakeStatus("requesting microphone");
      const AudioContextConstructor = getAudioContextConstructor();

      if (!AudioContextConstructor) {
        throw new Error("This browser does not support AudioContext microphone processing.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      wakeStreamRef.current = stream;
      resetWakeCapture();

      const audioContext = new AudioContextConstructor();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const preRollSampleLimit = Math.floor(audioContext.sampleRate * (WAKE_PREROLL_MS / 1000));
      const minSpeechSampleCount = Math.floor(audioContext.sampleRate * (WAKE_MIN_SPEECH_MS / 1000));
      const calibrationSampleCount = Math.floor(audioContext.sampleRate * (WAKE_CALIBRATION_MS / 1000));
      const endSilenceSampleCount = Math.floor(audioContext.sampleRate * (WAKE_END_SILENCE_MS / 1000));
      const maxUtteranceSampleCount = Math.floor(
        audioContext.sampleRate * (WAKE_MAX_UTTERANCE_MS / 1000),
      );

      processor.onaudioprocess = (event) => {
        wakeLastAudioProcessAtRef.current = Date.now();
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);

        if (!wakeEnabledRef.current || wakeFinishingRef.current) {
          return;
        }

        const input = new Float32Array(event.inputBuffer.getChannelData(0));
        const rms = getRms(input);
        const commandArmed = isWakeCommandArmed();
        const startThreshold = Math.max(
          WAKE_MIN_START_RMS,
          wakeNoiseFloorRef.current * WAKE_START_NOISE_MULTIPLIER,
        );
        const continueThreshold = Math.max(
          WAKE_MIN_CONTINUE_RMS,
          wakeNoiseFloorRef.current * WAKE_CONTINUE_NOISE_MULTIPLIER,
        );
        const speechThreshold = wakeSpeechStartedRef.current ? continueThreshold : startThreshold;
        const hasSpeech = rms >= speechThreshold;

        updateVoiceActivity(rms, speechThreshold);

        if (!wakeSpeechStartedRef.current) {
          if (!commandArmed && wakeCalibrationSampleCountRef.current < calibrationSampleCount) {
            if (hasSpeech) {
              startWakeCapture(input);
              setWakeStatus("hearing speech");
              setWakeTranscript("Checking for wake word...");
              return;
            }

            wakeCalibrationSampleCountRef.current += input.length;
            updateWakeNoiseFloor(rms);
            appendWakePreRoll(input, preRollSampleLimit);
            return;
          }

          if (hasSpeech) {
            startWakeCapture(input);
            setWakeStatus("hearing speech");
            setWakeTranscript(
              commandArmed ? "Listening for your command..." : "Checking for wake word...",
            );
            return;
          }

          updateWakeNoiseFloor(rms);
          appendWakePreRoll(input, preRollSampleLimit);
          return;
        }

        wakeSampleChunksRef.current.push(input);
        wakeSampleCountRef.current += input.length;

        if (hasSpeech) {
          wakeSilentSampleCountRef.current = 0;
          wakeVoiceSampleCountRef.current += input.length;
        } else {
          wakeSilentSampleCountRef.current += input.length;
        }

        if (wakeSampleCountRef.current >= maxUtteranceSampleCount) {
          void finishWakeSegment(false);
          return;
        }

        if (wakeSilentSampleCountRef.current < endSilenceSampleCount) {
          return;
        }

        if (wakeVoiceSampleCountRef.current >= minSpeechSampleCount) {
          void finishWakeSegment(false);
          return;
        }

        resetWakeCapture();
        setWakeStatus(commandArmed ? "awaiting command" : "listening");
        setWakeTranscript(
          commandArmed
            ? "I heard the wake word. Ask your question."
            : `Say "${wakeWordRef.current}" to wake me.`,
        );
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      wakeAudioContextRef.current = audioContext;
      wakeSourceRef.current = source;
      wakeProcessorRef.current = processor;
      wakeLastAudioProcessAtRef.current = Date.now();
      setWakeStatus(isWakeCommandArmed() ? "awaiting command" : "listening");
    } catch (error) {
      wakeEnabledRef.current = false;
      clearWakeCommand();
      setWakeEnabled(false);
      setWakeStatus("error");
      setErrorMessage(formatError(error));
      void releaseWakeAudio();
    }
  }

  async function processWakeChunk(wavBlob: Blob) {
    if (!wakeEnabledRef.current) {
      return;
    }

    try {
      if (wavBlob.size === 0) {
        scheduleWakeListening();
        return;
      }

      setWakeStatus("checking speech");
      const transcript = (await transcribeAudio(baseUrlRef.current, wavBlob)).trim();
      setTranscriptionText(transcript);

      if (!wakeEnabledRef.current) {
        return;
      }

      if (!transcript) {
        setLastIgnoredSpeech("No speech detected.");
        setWakeTranscript(
          isWakeCommandArmed()
            ? "I heard the wake word. Ask your question."
            : `Say "${wakeWordRef.current}" to wake me.`,
        );
        scheduleWakeListening();
        return;
      }

      if (isWakeCommandArmed()) {
        clearWakeCommand();
        setLastIgnoredSpeech("");
        setWakeTranscript(transcript);
        await answerWakeRecording(wavBlob, transcript);
        return;
      }

      if (!containsWakeWord(transcript, wakeWordRef.current)) {
        setLastIgnoredSpeech(transcript);
        setWakeTranscript(`Waiting for "${wakeWordRef.current}".`);
        scheduleWakeListening();
        return;
      }

      setLastIgnoredSpeech("");
      setWakeTranscript(transcript);

      if (!hasCommandAfterWakeWord(transcript, wakeWordRef.current)) {
        armWakeCommand();
        setWakeStatus("awaiting command");
        setWakeTranscript("I heard the wake word. Ask your question.");
        scheduleWakeListening();
        return;
      }

      await answerWakeRecording(wavBlob, transcript);
    } catch (error) {
      wakeEnabledRef.current = false;
      clearWakeCommand();
      setWakeEnabled(false);
      setWakeStatus("error");
      setErrorMessage(formatError(error));
    }
  }

  async function answerWakeRecording(wavBlob: Blob, transcript: string) {
    clearWakeCommand();
    setWakeStatus("wake word detected");
    resetConversationState();
    setTranscriptionText(transcript);

    try {
      await submitWavToAssistant(wavBlob, transcript);
    } catch (error) {
      setRequestStatus("error");
      setErrorMessage(formatError(error));
    } finally {
      wakeNoiseFloorRef.current = WAKE_INITIAL_NOISE_FLOOR;
      resumeWakeIfEnabled(WAKE_RESUME_AFTER_RESPONSE_MS);
    }
  }

  function pauseWakeListening() {
    if (!wakeEnabledRef.current) {
      return;
    }

    void releaseWakeAudio();
    setWakeStatus("paused");
  }

  function scheduleWakeListening(delayMs = WAKE_RESTART_DELAY_MS) {
    clearWakeTimers();

    if (!wakeEnabledRef.current) {
      return;
    }

    wakeRestartTimerRef.current = window.setTimeout(() => {
      wakeRestartTimerRef.current = undefined;
      void startWakeListening();
    }, delayMs);
  }

  function resumeWakeIfEnabled(delayMs = WAKE_RESTART_DELAY_MS) {
    if (wakeEnabledRef.current) {
      scheduleWakeListening(delayMs);
    }
  }

  function startWakeWatchdog() {
    stopWakeWatchdog();

    wakeWatchdogTimerRef.current = window.setInterval(() => {
      if (
        !wakeEnabledRef.current ||
        assistantBusyRef.current ||
        recorderRef.current ||
        wakeFinishingRef.current
      ) {
        return;
      }

      const stream = wakeStreamRef.current;

      if (!stream) {
        if (!wakeRestartTimerRef.current) {
          setVoiceActivity("Restarting wake listener.");
          scheduleWakeListening(0);
        }

        return;
      }

      const hasLiveTrack = stream.getAudioTracks().some((track) => track.readyState === "live");
      const lastAudioAt = wakeLastAudioProcessAtRef.current;
      const hasStalled =
        lastAudioAt > 0 && Date.now() - lastAudioAt > WAKE_AUDIO_STALL_MS;

      if (!hasLiveTrack || hasStalled) {
        void restartWakeListening(
          hasLiveTrack
            ? "Microphone processing stalled. Restarting wake listener."
            : "Microphone track ended. Restarting wake listener.",
        );
      }
    }, WAKE_WATCHDOG_MS);
  }

  function stopWakeWatchdog() {
    if (wakeWatchdogTimerRef.current) {
      window.clearInterval(wakeWatchdogTimerRef.current);
      wakeWatchdogTimerRef.current = undefined;
    }
  }

  async function restartWakeListening(message: string) {
    if (wakeRestartingRef.current || !wakeEnabledRef.current) {
      return;
    }

    wakeRestartingRef.current = true;
    setVoiceActivity(message);

    try {
      await releaseWakeAudio();
    } finally {
      wakeRestartingRef.current = false;
    }

    scheduleWakeListening(100);
  }

  function stopWakeListening({
    status,
  }: { ignoreChunk?: boolean; status?: WakeStatus } = {}) {
    clearWakeTimers();
    void releaseWakeAudio();

    if (status && mountedRef.current) {
      setWakeStatus(status);
    }
  }

  async function finishWakeSegment(ignoreChunk: boolean) {
    if (wakeFinishingRef.current) {
      return;
    }

    wakeFinishingRef.current = true;
    const audioContext = wakeAudioContextRef.current;
    const sampleRate = audioContext?.sampleRate ?? 16000;
    const samples = mergeWakeSamples(wakeSampleChunksRef.current, wakeSampleCountRef.current);
    await releaseWakeAudio();
    wakeFinishingRef.current = false;

    if (!ignoreChunk) {
      void processWakeChunk(float32SamplesToWavBlob(samples, sampleRate));
    }
  }

  async function releaseWakeAudio() {
    const processor = wakeProcessorRef.current;
    const source = wakeSourceRef.current;
    const stream = wakeStreamRef.current;
    const audioContext = wakeAudioContextRef.current;

    wakeProcessorRef.current = null;
    wakeSourceRef.current = null;
    wakeStreamRef.current = null;
    wakeAudioContextRef.current = null;
    wakeLastAudioProcessAtRef.current = 0;

    processor?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());

    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => undefined);
    }

    resetWakeCapture();
  }

  function resetWakeCapture() {
    wakePreRollChunksRef.current = [];
    wakePreRollSampleCountRef.current = 0;
    wakeCalibrationSampleCountRef.current = 0;
    wakeSampleChunksRef.current = [];
    wakeSampleCountRef.current = 0;
    wakeSilentSampleCountRef.current = 0;
    wakeVoiceSampleCountRef.current = 0;
    wakeSpeechStartedRef.current = false;
  }

  function armWakeCommand() {
    wakeCommandArmedRef.current = true;
    wakeCommandArmedAtRef.current = Date.now();
  }

  function clearWakeCommand() {
    wakeCommandArmedRef.current = false;
    wakeCommandArmedAtRef.current = 0;
  }

  function isWakeCommandArmed() {
    if (!wakeCommandArmedRef.current) {
      return false;
    }

    if (Date.now() - wakeCommandArmedAtRef.current <= WAKE_COMMAND_TIMEOUT_MS) {
      return true;
    }

    clearWakeCommand();
    setWakeStatus("listening");
    setWakeTranscript(`Say "${wakeWordRef.current}" to wake me.`);
    return false;
  }

  function startWakeCapture(input: Float32Array) {
    setTranscriptionText("");
    wakeSpeechStartedRef.current = true;
    wakeSampleChunksRef.current = [...wakePreRollChunksRef.current, input];
    wakeSampleCountRef.current = wakePreRollSampleCountRef.current + input.length;
    wakeSilentSampleCountRef.current = 0;
    wakeVoiceSampleCountRef.current = input.length;
    wakePreRollChunksRef.current = [];
    wakePreRollSampleCountRef.current = 0;
  }

  function appendWakePreRoll(input: Float32Array, sampleLimit: number) {
    wakePreRollChunksRef.current.push(input);
    wakePreRollSampleCountRef.current += input.length;

    while (
      wakePreRollSampleCountRef.current > sampleLimit &&
      wakePreRollChunksRef.current.length > 1
    ) {
      const removed = wakePreRollChunksRef.current.shift();
      wakePreRollSampleCountRef.current -= removed?.length ?? 0;
    }
  }

  function updateVoiceActivity(rms: number, threshold: number) {
    const now = Date.now();

    if (now - wakeLastActivityUpdateRef.current < WAKE_ACTIVITY_UPDATE_MS) {
      return;
    }

    wakeLastActivityUpdateRef.current = now;
    setVoiceSignal({
      level: rms,
      threshold,
      noise: wakeNoiseFloorRef.current,
    });
    setVoiceActivity(
      `level ${rms.toFixed(3)} / threshold ${threshold.toFixed(3)} / noise ${wakeNoiseFloorRef.current.toFixed(3)}`,
    );
  }

  function startRecordingVisualization(stream: MediaStream) {
    const AudioContextConstructor = getAudioContextConstructor();

    if (!AudioContextConstructor) {
      return;
    }

    try {
      const audioContext = new AudioContextConstructor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(2048, 1, 1);

      processor.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);

        if (recorderRef.current?.state !== "recording") {
          return;
        }

        const input = new Float32Array(event.inputBuffer.getChannelData(0));
        const rms = getRms(input);
        const threshold = Math.max(WAKE_MIN_CONTINUE_RMS, WAKE_INITIAL_NOISE_FLOOR * 2);
        updateVoiceActivity(rms, threshold);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      void audioContext.resume();

      recordingAudioContextRef.current = audioContext;
      recordingSourceRef.current = source;
      recordingProcessorRef.current = processor;
    } catch {
      setVoiceSignal(INITIAL_VOICE_SIGNAL);
    }
  }

  function stopRecordingVisualization() {
    recordingProcessorRef.current?.disconnect();
    recordingSourceRef.current?.disconnect();

    if (
      recordingAudioContextRef.current &&
      recordingAudioContextRef.current.state !== "closed"
    ) {
      void recordingAudioContextRef.current.close();
    }

    recordingAudioContextRef.current = null;
    recordingSourceRef.current = null;
    recordingProcessorRef.current = null;
  }

  function getAssistantOutputAudioContext({ create = false }: { create?: boolean } = {}) {
    const AudioContextConstructor = getAudioContextConstructor();

    if (!AudioContextConstructor) {
      return null;
    }

    let audioContext = assistantOutputAudioContextRef.current;

    if (audioContext?.state === "closed") {
      assistantOutputAudioContextRef.current = null;
      assistantOutputSourceRef.current = null;
      assistantOutputAnalyserRef.current = null;
      assistantOutputDataRef.current = null;
      audioContext = null;
    }

    if (!audioContext && create) {
      audioContext = new AudioContextConstructor();
      assistantOutputAudioContextRef.current = audioContext;
    }

    return audioContext;
  }

  function ensureAssistantOutputAnalyser(audioContext: AudioContext) {
    let analyser = assistantOutputAnalyserRef.current;

    if (!analyser) {
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(audioContext.destination);
      assistantOutputAnalyserRef.current = analyser;
    }

    return analyser;
  }

  function ensureAssistantMediaGraph(audio: HTMLAudioElement) {
    const audioContext = getAssistantOutputAudioContext();

    if (!audioContext || audioContext.state !== "running") {
      return null;
    }

    const analyser = ensureAssistantOutputAnalyser(audioContext);

    if (!assistantOutputSourceRef.current) {
      const source = audioContext.createMediaElementSource(audio);
      source.connect(analyser);
      assistantOutputSourceRef.current = source;
    }

    return { analyser, audioContext };
  }

  function startAssistantOutputVisualization(audio: HTMLAudioElement) {
    try {
      const graph = ensureAssistantMediaGraph(audio);

      if (!graph) {
        return;
      }

      startAssistantAnalyserLoop(graph.analyser, () => !audio.paused && !audio.ended);
    } catch {
      setVoiceSignal({
        level: 0.035,
        threshold: 0.045,
        noise: 0,
      });
    }
  }

  function startAssistantAnalyserLoop(analyser: AnalyserNode, isActive: () => boolean) {
    stopAssistantOutputVisualization({ resetSignal: false });
    assistantOutputDataRef.current = new Uint8Array(analyser.fftSize);

    const updateAssistantSignal = () => {
      const data = assistantOutputDataRef.current;

      if (!data || !isActive()) {
        return;
      }

      analyser.getByteTimeDomainData(data);
      let squareSum = 0;

      for (const sample of data) {
        const centeredSample = (sample - 128) / 128;
        squareSum += centeredSample * centeredSample;
      }

      const rms = Math.sqrt(squareSum / data.length);
      setVoiceSignal({
        level: rms,
        threshold: 0.045,
        noise: 0,
      });
      setVoiceActivity(`assistant output level ${rms.toFixed(3)}`);
      assistantOutputFrameRef.current = window.requestAnimationFrame(updateAssistantSignal);
    };

    assistantOutputFrameRef.current = window.requestAnimationFrame(updateAssistantSignal);
  }

  function canPlayAssistantBlobWithAudioContext() {
    const audioContext = assistantOutputAudioContextRef.current;
    return Boolean(audioContext && audioContext.state === "running");
  }

  async function resumeAssistantOutputContextIfUnlocked() {
    const audioContext = assistantOutputAudioContextRef.current;

    if (!assistantPlaybackUnlockedRef.current || !audioContext || audioContext.state !== "suspended") {
      return;
    }

    await audioContext.resume().catch(() => undefined);
  }

  async function playAssistantBlobWithAudioContext(audioBlob: Blob) {
    const audioContext = getAssistantOutputAudioContext();

    if (!audioContext || audioContext.state !== "running") {
      throw new Error("Assistant audio context is not unlocked.");
    }

    stopAssistantOutputBufferSource();
    const analyser = ensureAssistantOutputAnalyser(audioContext);
    const audioBuffer = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
    const source = audioContext.createBufferSource();
    let isPlaying = true;

    source.buffer = audioBuffer;
    source.connect(analyser);
    assistantOutputBufferSourceRef.current = source;

    await new Promise<void>((resolve, reject) => {
      source.addEventListener(
        "ended",
        () => {
          isPlaying = false;
          try {
            source.disconnect();
          } catch {
            // Already disconnected.
          }

          if (assistantOutputBufferSourceRef.current === source) {
            assistantOutputBufferSourceRef.current = null;
          }

          stopAssistantOutputVisualization();
          resolve();
        },
        { once: true },
      );

      try {
        startAssistantAnalyserLoop(
          analyser,
          () => isPlaying && audioContext.state !== "closed" && audioContext.state !== "suspended",
        );
        source.start();
      } catch (error) {
        isPlaying = false;
        try {
          source.disconnect();
        } catch {
          // Already disconnected.
        }

        if (assistantOutputBufferSourceRef.current === source) {
          assistantOutputBufferSourceRef.current = null;
        }

        stopAssistantOutputVisualization();
        reject(error);
      }
    });
  }

  function stopAssistantOutputBufferSource() {
    const source = assistantOutputBufferSourceRef.current;

    if (!source) {
      return;
    }

    assistantOutputBufferSourceRef.current = null;

    try {
      source.stop();
    } catch {
      // Already stopped.
    }

    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  function primeAssistantAudioContext(audioContext: AudioContext) {
    const sampleCount = Math.max(1, Math.floor(audioContext.sampleRate * 0.05));
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();

    source.buffer = audioContext.createBuffer(1, sampleCount, audioContext.sampleRate);
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(audioContext.destination);
    source.start();
  }

  function stopAssistantOutputVisualization({
    resetSignal = true,
    dispose = false,
  }: { resetSignal?: boolean; dispose?: boolean } = {}) {
    if (assistantOutputFrameRef.current) {
      window.cancelAnimationFrame(assistantOutputFrameRef.current);
      assistantOutputFrameRef.current = undefined;
    }

    if (dispose) {
      stopAssistantOutputBufferSource();
      assistantOutputSourceRef.current?.disconnect();
      assistantOutputAnalyserRef.current?.disconnect();

      if (
        assistantOutputAudioContextRef.current &&
        assistantOutputAudioContextRef.current.state !== "closed"
      ) {
        void assistantOutputAudioContextRef.current.close();
      }

      assistantOutputAudioContextRef.current = null;
      assistantOutputSourceRef.current = null;
      assistantOutputAnalyserRef.current = null;
      assistantOutputBufferSourceRef.current = null;
      assistantOutputDataRef.current = null;
    }

    if (resetSignal) {
      setVoiceSignal(INITIAL_VOICE_SIGNAL);
    }
  }

  function updateWakeNoiseFloor(rms: number) {
    wakeNoiseFloorRef.current = wakeNoiseFloorRef.current * 0.95 + rms * 0.05;
  }

  function clearWakeTimers() {
    if (wakeRestartTimerRef.current) {
      window.clearTimeout(wakeRestartTimerRef.current);
      wakeRestartTimerRef.current = undefined;
    }
  }

  function stopMicrophoneTracks() {
    stopRecordingVisualization();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  function revokeAssistantAudioUrl() {
    stopAssistantOutputVisualization();
    assistantAudioBlobRef.current = null;

    if (assistantAudioUrlRef.current) {
      URL.revokeObjectURL(assistantAudioUrlRef.current);
      assistantAudioUrlRef.current = "";
    }
  }

  function clearAssistantAudioUrl() {
    revokeAssistantAudioUrl();
    setAssistantAudioUrl("");
  }

  function resetConversationState() {
    setErrorMessage("");
    setAssistantText("");
    setTranscriptionText("");
    setRawResponse("");
    setAssistantNeedsTap(false);
    setRequestStatus("idle");
    clearAssistantAudioUrl();
  }

  const isRecording = recordingStatus === "recording";
  const isAssistantBusy =
    requestStatus === "converting audio" ||
    requestStatus === "transcribing audio" ||
    requestStatus === "sending to Speaches" ||
    requestStatus === "calling Gemini" ||
    requestStatus === "synthesizing speech" ||
    requestStatus === "playing response";
  const isBusy =
    recordingStatus === "requesting microphone" || recordingStatus === "stopping" || isAssistantBusy;
  const phoneAccessUrl = getPhoneAccessUrl();
  const phoneQrDataUrl = useMemo(
    () => (phoneAccessUrl ? createQrSvgDataUrl(phoneAccessUrl) : ""),
    [phoneAccessUrl],
  );
  const phoneUrlIsSecure = phoneAccessUrl.startsWith("https://");

  async function copyPhoneAccessUrl() {
    if (!phoneAccessUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(phoneAccessUrl);
      setPhoneCopyStatus("Copied");
    } catch {
      setPhoneCopyStatus("Copy failed");
    }

    window.setTimeout(() => {
      if (mountedRef.current) {
        setPhoneCopyStatus("");
      }
    }, 1600);
  }

  return (
    <main className="app-shell">
      <section className="assistant-console" aria-labelledby="app-title">
        <header className="console-header">
          <div className="intro">
            <p className="eyebrow">Local neural voice console</p>
            <h1 id="app-title">Voice Assistant</h1>
          </div>
          <span
            className={
              isRecording ||
              wakeStatus === "listening" ||
              wakeStatus === "hearing speech" ||
              wakeStatus === "awaiting command"
                ? "status-pill active"
                : "status-pill"
            }
          >
            {isRecording ? recordingStatus : wakeStatus}
          </span>
        </header>

        <VoiceVisualizer
          assistantAudioUrl={assistantAudioUrl}
          assistantNeedsTap={assistantNeedsTap}
          assistantText={assistantText}
          onAudioElementReady={setAssistantPlaybackElement}
          onPlayAssistantAudio={retryAssistantAudioPlayback}
          recordingStatus={recordingStatus}
          requestStatus={requestStatus}
          signal={voiceSignal}
          wakeStatus={wakeStatus}
          wakeTranscript={wakeTranscript}
          wakeWord={wakeWord}
        />

        <div className="button-row primary-actions">
          <button type="button" onClick={enableWakeMode} disabled={wakeEnabled || isBusy}>
            <span className="button-glyph glyph-ring" aria-hidden="true" />
            Wake
          </button>
          <button
            className="secondary"
            type="button"
            onClick={disableWakeMode}
            disabled={!wakeEnabled}
          >
            <span className="button-glyph glyph-idle" aria-hidden="true" />
            Sleep
          </button>
          <button type="button" onClick={startRecording} disabled={isBusy || isRecording}>
            <span className="button-glyph glyph-dot" aria-hidden="true" />
            Record
          </button>
          <button
            className="secondary"
            type="button"
            onClick={stopRecording}
            disabled={!isRecording}
          >
            <span className="button-glyph glyph-square" aria-hidden="true" />
            Stop
          </button>
        </div>

        <div className="wake-line" aria-live="polite">
          <span className={wakeEnabled ? "status-pill active" : "status-pill"}>{wakeStatus}</span>
          <span>{wakeTranscript || `Waiting for "${wakeWord}"`}</span>
        </div>

        <details className="settings-panel">
          <summary>Assistant settings</summary>
          <div className="control-grid">
            <label className="field">
              <span>LLM Provider</span>
              <select
                aria-label="LLM Provider"
                value={llmProvider}
                onChange={(event) => setLlmProvider(event.target.value as LlmProvider)}
              >
                <option value="local">Local Speaches + Ollama</option>
                <option value="gemini">Global Gemini API</option>
              </select>
            </label>

            <label className="field">
              <span>Speaches Base URL</span>
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={DEFAULT_SPEACHES_BASE_URL}
                spellCheck={false}
              />
            </label>
          </div>

          {llmProvider === "local" ? (
            <section className="provider-panel" aria-label="Local model info">
              <div className="provider-panel-header">
                <div>
                  <p className="section-kicker">Local mode</p>
                  <h2>Speaches + Ollama</h2>
                </div>
                <button
                  className="secondary compact"
                  type="button"
                  onClick={() => setShowLocalInfo((value) => !value)}
                  aria-expanded={showLocalInfo}
                >
                  Info
                </button>
              </div>
              {showLocalInfo ? (
                <p className="provider-note">
                  Local mode sends one request to Speaches. Speaches transcribes the audio, proxies
                  chat to Ollama, generates Kokoro TTS audio, and returns the final WAV response.
                  Your browser does not call Ollama directly.
                </p>
              ) : null}
            </section>
          ) : (
            <section className="provider-panel" aria-label="Gemini model settings">
              <div className="provider-panel-header">
                <div>
                  <p className="section-kicker">Global mode</p>
                  <h2>Gemini API</h2>
                </div>
              </div>
              <div className="control-grid provider-grid">
                <label className="field">
                  <span>Model</span>
                  <input value="Gemini 2.5 Flash" readOnly />
                </label>

                <label className="field">
                  <span>Gemini API Key</span>
                  <input
                    type="password"
                    value={geminiApiKey}
                    onChange={(event) => setGeminiApiKey(event.target.value)}
                    placeholder="AIza..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
              <p className="provider-note">
                Gemini mode uses Speaches for STT and TTS, but sends the transcribed text to Gemini
                2.5 Flash from this browser. Keep this key for local use only.
              </p>
            </section>
          )}

          <section className="provider-panel phone-panel" aria-label="Phone access">
            <div className="provider-panel-header">
              <div>
                <p className="section-kicker">Home network</p>
                <h2>Phone access</h2>
              </div>
              <button
                className="secondary compact"
                type="button"
                onClick={() => setShowPhoneQr((value) => !value)}
                disabled={!phoneAccessUrl}
                aria-expanded={showPhoneQr}
              >
                {showPhoneQr ? "Hide QR" : "Phone QR"}
              </button>
            </div>

            {phoneAccessUrl ? (
              <>
                <div className="phone-url-row">
                  <label className="field">
                    <span>Phone URL</span>
                    <input
                      value={phoneAccessUrl}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </label>
                  <button className="secondary compact" type="button" onClick={copyPhoneAccessUrl}>
                    {phoneCopyStatus || "Copy"}
                  </button>
                </div>

                {showPhoneQr ? (
                  <div className="qr-card">
                    <img src={phoneQrDataUrl} alt={`QR code for ${phoneAccessUrl}`} />
                    <p>
                      Scan this on a phone connected to the same Wi-Fi. If it still does not open,
                      allow Node/Vite through Windows Firewall for private networks.
                    </p>
                  </div>
                ) : null}

                {!phoneUrlIsSecure ? (
                  <p className="provider-note warning-note">
                    Mobile microphone access needs HTTPS. Generate the LAN certificate and run the
                    HTTPS Vite server before testing voice on a phone.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="provider-note warning-note">
                I could not detect a private LAN IP. Connect this PC to Wi-Fi/Ethernet and restart
                the Vite dev server.
              </p>
            )}
          </section>

          <div className="control-grid single-setting-row">
            <label className="field">
              <span>Wake Word</span>
              <input
                type="text"
                value={wakeWord}
                onChange={(event) => setWakeWord(event.target.value)}
                placeholder={DEFAULT_WAKE_WORD}
                disabled={wakeEnabled}
                spellCheck={false}
              />
            </label>
          </div>

          <section className="env-panel" aria-labelledby="system-role-title">
            <div className="env-panel-header">
              <div>
                <p className="section-kicker">Prompt env</p>
                <h2 id="system-role-title">System Role</h2>
              </div>
              <button
                className="secondary compact"
                type="button"
                onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
              >
                Reset
              </button>
            </div>
            <label className="field system-field" htmlFor="system-role-input">
              <span>System Role</span>
            </label>
            <textarea
              id="system-role-input"
              aria-label="System Role"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              spellCheck={false}
            />
          </section>

          <div className="model-strip" aria-label="Configured models">
            <span>{llmProvider === "gemini" ? "Gemini 2.5 Flash" : OLLAMA_MODEL}</span>
            <span>{STT_MODEL}</span>
            <span>{TTS_MODEL}</span>
            <span>{TTS_VOICE}</span>
          </div>
        </details>

        {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
      </section>

      <details className="debug-panel" aria-label="Debug panel">
        <summary>Debug</summary>

        <dl className="debug-list">
          <div>
            <dt>LLM provider</dt>
            <dd>{llmProvider === "gemini" ? "Gemini 2.5 Flash" : "Local Speaches + Ollama"}</dd>
          </div>
          <div>
            <dt>Phone URL</dt>
            <dd>{phoneAccessUrl || "No LAN IP detected."}</dd>
          </div>
          <div>
            <dt>Wake status</dt>
            <dd>{wakeStatus}</dd>
          </div>
          <div>
            <dt>Wake transcript</dt>
            <dd>{wakeTranscript || "None yet."}</dd>
          </div>
          <div>
            <dt>Ignored speech</dt>
            <dd>{lastIgnoredSpeech || "None"}</dd>
          </div>
          <div>
            <dt>Voice activity</dt>
            <dd>{voiceActivity || "Waiting for microphone."}</dd>
          </div>
          <div>
            <dt>Recording status</dt>
            <dd>{recordingStatus}</dd>
          </div>
          <div>
            <dt>Request status</dt>
            <dd>{requestStatus}</dd>
          </div>
          <div>
            <dt>Raw transcription</dt>
            <dd>{transcriptionText || "Not returned separately."}</dd>
          </div>
          <div>
            <dt>Assistant text</dt>
            <dd>{assistantText || "None yet."}</dd>
          </div>
          <div>
            <dt>Browser microphone</dt>
            <dd>{getMicrophoneDebugStatus()}</dd>
          </div>
          <div>
            <dt>Errors</dt>
            <dd className={errorMessage ? "error-text" : undefined}>{errorMessage || "None"}</dd>
          </div>
        </dl>

        <details>
          <summary>Raw response</summary>
          <pre>{rawResponse || "No response yet."}</pre>
        </details>
      </details>
    </main>
  );
}

type VoiceVisualizerProps = {
  assistantAudioUrl: string;
  assistantNeedsTap: boolean;
  assistantText: string;
  onAudioElementReady: (element: HTMLAudioElement | null) => void;
  onPlayAssistantAudio: () => void;
  recordingStatus: RecordingStatus;
  requestStatus: RequestStatus;
  signal: VoiceSignal;
  wakeStatus: WakeStatus;
  wakeTranscript: string;
  wakeWord: string;
};

function VoiceVisualizer({
  assistantAudioUrl,
  assistantNeedsTap,
  assistantText,
  onAudioElementReady,
  onPlayAssistantAudio,
  recordingStatus,
  requestStatus,
  signal,
  wakeStatus,
  wakeTranscript,
  wakeWord,
}: VoiceVisualizerProps) {
  const threshold = Math.max(signal.threshold, 0.006);
  const voiceLevel = clamp(signal.level / threshold, 0, 1);
  const mode = getVisualizerMode({ recordingStatus, requestStatus, wakeStatus });
  const displayLevel =
    mode === "thinking"
      ? Math.max(voiceLevel, 0.68)
      : mode === "speaking"
        ? Math.max(voiceLevel, 0.36)
        : voiceLevel;
  const visualizerStyle = {
    "--voice-level": displayLevel.toFixed(3),
    "--overlay-opacity": (0.18 + displayLevel * 0.55).toFixed(3),
    "--overlay-offset": `${(1 - displayLevel) * 20}px`,
    "--ring-scale": (0.95 + displayLevel * 0.12).toFixed(3),
    "--core-scale": (0.84 + displayLevel * 0.18).toFixed(3),
    "--core-glow": `${28 + displayLevel * 44}px`,
    "--inner-glow": `${16 + displayLevel * 32}px`,
    "--inner-inset-glow": `${18 + displayLevel * 24}px`,
    "--line-scale": (0.52 + displayLevel * 0.32).toFixed(3),
    "--bar-opacity": (0.32 + displayLevel * 0.68).toFixed(3),
    "--meter-width": `${8 + displayLevel * 92}%`,
  } as CSSProperties;
  const caption = getVisualizerCaption({
    mode,
    requestStatus,
    wakeStatus,
    wakeTranscript,
    wakeWord,
  });
  const assistantPreview =
    mode === "thinking"
      ? getProcessingText(requestStatus, wakeStatus)
      : assistantText || "Assistant response will appear here.";

  return (
    <section
      className={`voice-visualizer mode-${mode}`}
      style={visualizerStyle}
      aria-label="Assistant response"
      aria-live="polite"
    >
      <div className="visualizer-topline">
        <span>Assistant core</span>
        <strong>{mode}</strong>
      </div>

      <div className="signal-stage" aria-hidden="true">
        <div className="signal-grid" />
        <div className="signal-ring ring-outer" />
        <div className="signal-ring ring-mid" />
        <div className="signal-ring ring-inner" />
        <div className="processing-sweep" />
        <div className="signal-core">
          <span />
          <span />
          <span />
        </div>
        <div className="wave-bars">
          {WAVE_BAR_WEIGHTS.map((weight, index) => (
            <i
              key={`${weight}-${index}`}
              style={
                {
                  "--bar-height": `${18 + displayLevel * weight * 104}px`,
                  "--bar-delay": `${index * 34}ms`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      </div>

      <div className="visualizer-readout">
        <span>{caption}</span>
        <p>{assistantPreview}</p>
        {mode === "thinking" ? (
          <div className="processing-indicator" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        {assistantNeedsTap && assistantAudioUrl ? (
          <button
            className="secondary compact play-response-button"
            type="button"
            onClick={onPlayAssistantAudio}
          >
            Play response
          </button>
        ) : null}
        <audio
          ref={onAudioElementReady}
          className={assistantAudioUrl ? "audio-player" : "audio-player dormant"}
          controls={Boolean(assistantAudioUrl)}
          src={assistantAudioUrl || undefined}
          preload="auto"
        >
          <track kind="captions" />
        </audio>
      </div>

      <div className="signal-meter" aria-hidden="true">
        <span />
      </div>
    </section>
  );
}

function getVisualizerMode({
  recordingStatus,
  requestStatus,
  wakeStatus,
}: {
  recordingStatus: RecordingStatus;
  requestStatus: RequestStatus;
  wakeStatus: WakeStatus;
}): VisualizerMode {
  if (requestStatus === "playing response" || requestStatus === "complete") {
    return requestStatus === "playing response" ? "speaking" : "answered";
  }

  if (requestStatus === "converting audio" || requestStatus === "sending to Speaches") {
    return "thinking";
  }

  if (
    requestStatus === "transcribing audio" ||
    requestStatus === "calling Gemini" ||
    requestStatus === "synthesizing speech"
  ) {
    return "thinking";
  }

  if (recordingStatus === "recording") {
    return "recording";
  }

  if (wakeStatus === "hearing speech" || wakeStatus === "wake word detected") {
    return "hearing";
  }

  if (wakeStatus === "checking speech") {
    return "thinking";
  }

  if (wakeStatus === "listening" || wakeStatus === "awaiting command") {
    return "listening";
  }

  return "idle";
}

function getVisualizerCaption({
  mode,
  requestStatus,
  wakeStatus,
  wakeTranscript,
  wakeWord,
}: {
  mode: VisualizerMode;
  requestStatus: RequestStatus;
  wakeStatus: WakeStatus;
  wakeTranscript: string;
  wakeWord: string;
}) {
  if (mode === "speaking") {
    return "Assistant is speaking";
  }

  if (mode === "thinking") {
    if (requestStatus === "converting audio") {
      return "Preparing audio";
    }

    if (requestStatus === "sending to Speaches") {
      return "Processing with Speaches";
    }

    if (requestStatus === "transcribing audio") {
      return "Transcribing audio";
    }

    if (requestStatus === "calling Gemini") {
      return "Calling Gemini";
    }

    if (requestStatus === "synthesizing speech") {
      return "Generating voice";
    }

    if (wakeStatus === "checking speech") {
      return "Checking speech";
    }

    return "Processing";
  }

  return wakeTranscript || (mode === "idle" ? `Wake phrase: ${wakeWord}` : `Listening for "${wakeWord}"`);
}

function getProcessingText(requestStatus: RequestStatus, wakeStatus: WakeStatus) {
  if (requestStatus === "converting audio") {
    return "Converting the recording to WAV...";
  }

  if (requestStatus === "sending to Speaches") {
    return "Transcribing, thinking, and preparing the voice reply...";
  }

  if (requestStatus === "transcribing audio") {
    return "Speaches is transcribing the recording...";
  }

  if (requestStatus === "calling Gemini") {
    return "Gemini 2.5 Flash is preparing the answer...";
  }

  if (requestStatus === "synthesizing speech") {
    return "Speaches is turning the answer into voice...";
  }

  if (wakeStatus === "checking speech") {
    return "Listening segment captured. Checking the wake phrase...";
  }

  return "Working on it...";
}

function containsWakeWord(transcript: string, wakeWord: string) {
  const normalizedTranscript = normalizeSpeechText(transcript);
  const normalizedWakeWord = normalizeSpeechText(wakeWord);

  if (!normalizedTranscript || !normalizedWakeWord) {
    return false;
  }

  return Boolean(findWakeWordMatch(normalizedTranscript, normalizedWakeWord));
}

function hasCommandAfterWakeWord(transcript: string, wakeWord: string) {
  const normalizedTranscript = normalizeSpeechText(transcript);
  const normalizedWakeWord = normalizeSpeechText(wakeWord);
  const match = findWakeWordMatch(normalizedTranscript, normalizedWakeWord);

  if (!match) {
    return false;
  }

  return normalizedTranscript.split(" ").filter(Boolean).slice(match.end).join("").length >= 3;
}

function findWakeWordMatch(normalizedTranscript: string, normalizedWakeWord: string) {
  const transcriptTokens = normalizedTranscript.split(" ").filter(Boolean);
  const wakeTokens = normalizedWakeWord.split(" ").filter(Boolean);

  if (wakeTokens.length === 0 || transcriptTokens.length < wakeTokens.length) {
    return null;
  }

  for (let start = 0; start <= transcriptTokens.length - wakeTokens.length; start += 1) {
    const matches = wakeTokens.every((wakeToken, index) =>
      areSimilarWakeTokens(transcriptTokens[start + index], wakeToken),
    );

    if (matches) {
      return { start, end: start + wakeTokens.length };
    }
  }

  return null;
}

function areSimilarWakeTokens(token: string, wakeToken: string) {
  if (token === wakeToken) {
    return true;
  }

  if (wakeToken.length < 4 || token.length < 4) {
    return false;
  }

  if (Math.abs(token.length - wakeToken.length) > 1) {
    return false;
  }

  return levenshteinDistance(token, wakeToken) <= 1;
}

function levenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function getAudioContextConstructor() {
  const browserWindow = window as BrowserWindowWithAudioContext;
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
}

function mergeWakeSamples(chunks: Float32Array[], sampleCount: number) {
  const samples = new Float32Array(sampleCount);
  let offset = 0;

  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  return samples;
}

function getRms(samples: Float32Array) {
  if (samples.length === 0) {
    return 0;
  }

  let squareSum = 0;

  for (const sample of samples) {
    squareSum += sample * sample;
  }

  return Math.sqrt(squareSum / samples.length);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function playAudioToEnd(
  audio: HTMLAudioElement,
  options: { onBeforePlay?: () => void; onDone?: () => void } = {},
) {
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      options.onDone?.();
    }
    function handleEnded() {
      cleanup();
      resolve();
    }
    function handleError() {
      cleanup();
      reject(new Error("Could not play assistant audio."));
    }

    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    options.onBeforePlay?.();
    audio.play().catch(handleError);
  });
}

function createSilentWavDataUrl() {
  const sampleRate = 8000;
  const sampleCount = Math.floor(sampleRate * 0.2);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  let offset = 0;

  function writeString(value: string) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  }

  writeString("RIFF");
  view.setUint32(offset, 36 + sampleCount * 2, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * 2, true);
  offset += 4;
  view.setUint16(offset, 2, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, sampleCount * 2, true);

  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return `data:audio/wav;base64,${window.btoa(binary)}`;
}

function getMicrophoneSupportError({ requireMediaRecorder }: { requireMediaRecorder: boolean }) {
  if (!window.isSecureContext) {
    const phoneUrl = getPhoneAccessUrl();

    return [
      "Microphone access requires HTTPS or localhost.",
      phoneUrl
        ? `For phone/LAN use, open the HTTPS LAN URL from the Phone access QR panel: ${phoneUrl}.`
        : "For phone/LAN use, open the HTTPS LAN URL from the Phone access QR panel.",
    ].join(" ");
  }

  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    return [
      "This browser does not expose microphone recording.",
      "Use Chrome, Edge, or Safari directly; some embedded in-app browsers block microphone APIs.",
    ].join(" ");
  }

  if (requireMediaRecorder && typeof window.MediaRecorder !== "function") {
    return "This browser does not support MediaRecorder. Use a current Chrome, Edge, or Safari browser.";
  }

  return "";
}

function getMicrophoneDebugStatus() {
  const secureContext = window.isSecureContext ? "secure" : "not secure";
  const mediaDevices =
    typeof navigator.mediaDevices?.getUserMedia === "function"
      ? "getUserMedia yes"
      : "getUserMedia no";
  const mediaRecorder =
    typeof window.MediaRecorder === "function" ? "MediaRecorder yes" : "MediaRecorder no";

  return `${secureContext}, ${mediaDevices}, ${mediaRecorder}`;
}

function normalizeSpeechText(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default App;
