export const DEFAULT_SPEACHES_BASE_URL = "http://localhost:8000";
export const OLLAMA_MODEL = "qwen3:8b";
export const STT_MODEL = "Systran/faster-whisper-small";
export const TTS_MODEL = "speaches-ai/Kokoro-82M-v1.0-ONNX";
export const TTS_VOICE = "af_heart";

const FALLBACK_SYSTEM_PROMPT =
  "You are my English teacher for a Turkish speaker. Always reply in English only, even if I speak Turkish. Understand Turkish when needed, but do not answer in Turkish. Use simple, natural English. Keep replies short, friendly, and practical. Teach gently: correct only one important English mistake at a time, then ask one simple daily-life question. Do not use emojis.";

export const DEFAULT_SYSTEM_PROMPT =
  import.meta.env.VITE_SYSTEM_PROMPT?.trim() || FALLBACK_SYSTEM_PROMPT;

type ChatCompletionMessage = {
  content?: unknown;
  audio?: {
    data?: unknown;
    transcript?: unknown;
    input_transcription?: unknown;
  };
  transcription?: unknown;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: ChatCompletionMessage;
    text?: unknown;
    transcription?: unknown;
  }>;
  transcription?: unknown;
  input_transcription?: unknown;
};

export type SpeachesChatResult = {
  assistantText: string;
  assistantAudioBase64: string;
  transcriptionText: string;
  rawResponse: unknown;
};

export type SpeachesTextChatResult = {
  assistantText: string;
  rawResponse: unknown;
};

type TranscriptionResponse = {
  text?: unknown;
};

export function getDefaultSpeachesBaseUrl() {
  const hostname = window.location.hostname;

  if (window.location.protocol === "https:") {
    return window.location.origin;
  }

  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
    return DEFAULT_SPEACHES_BASE_URL;
  }

  return window.location.origin;
}

export async function transcribeAudio(baseUrl: string, wavBlob: Blob) {
  const endpoint = `${trimTrailingSlash(baseUrl)}/v1/audio/transcriptions`;
  const formData = new FormData();
  formData.append("file", wavBlob, "wake-word.wav");
  formData.append("model", STT_MODEL);

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error(`Could not read a transcription response from ${endpoint}.`);
    }

    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Speaches transcription failed with ${response.status} ${response.statusText}: ${errorText}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const result = (await response.json()) as TranscriptionResponse;
    return asString(result.text);
  }

  return response.text();
}

export async function synthesizeSpeech(baseUrl: string, input: string) {
  const endpoint = `${trimTrailingSlash(baseUrl)}/v1/audio/speech`;

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input,
        voice: TTS_VOICE,
        response_format: "wav",
      }),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error(`Could not read a TTS response from ${endpoint}.`);
    }

    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Speaches TTS failed with ${response.status} ${response.statusText}: ${errorText}`,
    );
  }

  return response.blob();
}

export async function sendAudioChat(
  baseUrl: string,
  base64Wav: string,
  wakeWord = "",
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
) {
  const endpoint = `${trimTrailingSlash(baseUrl)}/v1/chat/completions`;
  let response: Response;
  const systemContent = getSystemContent(wakeWord, systemPrompt);

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        modalities: ["text", "audio"],
        audio: { voice: TTS_VOICE, format: "wav" },
        transcription_model: STT_MODEL,
        speech_model: TTS_MODEL,
        messages: [
          {
            role: "system",
            content: systemContent,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Listen to my recording and answer naturally." },
              { type: "input_audio", input_audio: { data: base64Wav, format: "wav" } },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error(
        [
          `Could not read a response from ${endpoint}.`,
          "Speaches is reachable from this machine, but browser fetch can show this when Speaches returns an internal 500 without CORS headers.",
          'For Speaches Docker, restart it with LOOPBACK_HOST_URL=http://localhost:8000 and CHAT_COMPLETION_BASE_URL=http://host.docker.internal:11434/v1.',
        ].join(" "),
      );
    }

    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Speaches request failed with ${response.status} ${response.statusText}: ${errorText}`,
    );
  }

  const rawResponse = (await response.json()) as ChatCompletionResponse;
  const parsedResponse = parseChatCompletion(rawResponse);

  return {
    ...parsedResponse,
    rawResponse,
  } satisfies SpeachesChatResult;
}

export async function sendTextChat(
  baseUrl: string,
  transcript: string,
  wakeWord = "",
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
) {
  const endpoint = `${trimTrailingSlash(baseUrl)}/v1/chat/completions`;
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: "system",
            content: getSystemContent(wakeWord, systemPrompt),
          },
          {
            role: "user",
            content: [
              "This is the transcript of my spoken message.",
              `Transcript: ${transcript}`,
              "If the transcript includes the configured wake phrase, ignore only that phrase and answer the actual message naturally.",
            ].join("\n"),
          },
        ],
      }),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error(`Could not read a text chat response from ${endpoint}.`);
    }

    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Speaches text chat failed with ${response.status} ${response.statusText}: ${errorText}`,
    );
  }

  const rawResponse = (await response.json()) as ChatCompletionResponse;
  const parsedResponse = parseChatCompletion(rawResponse);

  return {
    assistantText: parsedResponse.assistantText,
    rawResponse,
  } satisfies SpeachesTextChatResult;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function getSystemContent(wakeWord = "", systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const rolePrompt = systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  const wakeInstruction = wakeWord.trim()
    ? ` The configured wake phrase is "${wakeWord.trim()}"; do not treat it as part of my message.`
    : "";

  return `${rolePrompt}${wakeInstruction}`;
}

function parseChatCompletion(rawResponse: ChatCompletionResponse) {
  const message = rawResponse.choices?.[0]?.message;
  const assistantAudioBase64 = asString(message?.audio?.data);
  const assistantTranscript = asString(message?.audio?.transcript);
  const assistantText =
    textFromContent(message?.content) ||
    assistantTranscript ||
    textFromContent(rawResponse.choices?.[0]?.text);

  const transcriptionText =
    asString(rawResponse.input_transcription) ||
    asString(rawResponse.transcription) ||
    asString(rawResponse.choices?.[0]?.transcription) ||
    asString(message?.transcription) ||
    asString(message?.audio?.input_transcription);

  return {
    assistantText,
    assistantAudioBase64,
    transcriptionText,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part === "object" && "text" in part) {
        return asString(part.text);
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
