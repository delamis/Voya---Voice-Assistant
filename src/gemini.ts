export const GEMINI_MODEL = "gemini-2.5-flash";

type GeminiPart = {
  text?: unknown;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    message?: unknown;
  };
};

export type GeminiChatResult = {
  assistantText: string;
  rawResponse: unknown;
};

export async function sendGeminiTextChat({
  apiKey,
  model,
  systemPrompt,
  transcript,
  wakeWord,
}: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  transcript: string;
  wakeWord: string;
}) {
  const trimmedApiKey = apiKey.trim();

  if (!trimmedApiKey) {
    throw new Error("Gemini API key is required when Global Gemini mode is selected.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(trimmedApiKey)}`;
  const wakeInstruction = wakeWord.trim()
    ? ` The configured wake phrase is "${wakeWord.trim()}"; ignore it if it appears in the user's transcript.`
    : "";
  const body = {
    systemInstruction: {
      parts: [{ text: `${systemPrompt.trim()}${wakeInstruction}` }],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "The user spoke this transcript.",
              "Answer naturally according to the system role.",
              "",
              transcript,
            ].join("\n"),
          },
        ],
      },
    ],
  };

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error("Could not reach Gemini API from this browser.");
    }

    throw error;
  }

  const rawResponse = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(
      `Gemini request failed with ${response.status} ${response.statusText}: ${asString(
        rawResponse.error?.message,
      )}`,
    );
  }

  const assistantText =
    rawResponse.candidates?.[0]?.content?.parts
      ?.map((part) => asString(part.text))
      .filter(Boolean)
      .join("\n")
      .trim() ?? "";

  if (!assistantText) {
    throw new Error("Gemini returned no assistant text.");
  }

  return {
    assistantText,
    rawResponse,
  } satisfies GeminiChatResult;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}
