type BrowserWindowWithAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function getAudioContextConstructor() {
  const browserWindow = window as BrowserWindowWithAudioContext;
  return browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
}

export function getBestRecordingMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  if (!("MediaRecorder" in window)) {
    return "";
  }

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

export async function recordedBlobToBase64Wav(recordedBlob: Blob) {
  return blobToBase64(await recordedBlobToWavBlob(recordedBlob));
}

export async function recordedBlobToWavBlob(recordedBlob: Blob) {
  const AudioContextConstructor = getAudioContextConstructor();

  if (!AudioContextConstructor) {
    throw new Error("This browser does not support AudioContext audio decoding.");
  }

  const audioContext = new AudioContextConstructor();

  try {
    const audioBuffer = await audioContext.decodeAudioData(await recordedBlob.arrayBuffer());
    return audioBufferToMonoWav(audioBuffer);
  } finally {
    await audioContext.close();
  }
}

export function wavBlobToBase64(wavBlob: Blob) {
  return blobToBase64(wavBlob);
}

export function base64ToWavBlob(base64Audio: string) {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new Blob([bytes], { type: "audio/wav" });
}

export function float32SamplesToWavBlob(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const wavHeaderSize = 44;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(wavHeaderSize + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = wavHeaderSize;

  for (const sampleValue of samples) {
    const sample = Math.max(-1, Math.min(1, sampleValue));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([view], { type: "audio/wav" });
}

function audioBufferToMonoWav(audioBuffer: AudioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const sampleCount = audioBuffer.length;
  const bytesPerSample = 2;
  const wavHeaderSize = 44;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(wavHeaderSize + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );

  let offset = wavHeaderSize;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let sample = 0;

    for (const channel of channels) {
      sample += channel[sampleIndex];
    }

    sample = Math.max(-1, Math.min(1, sample / channelCount));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      const result = reader.result;

      if (typeof result !== "string") {
        reject(new Error("Could not convert recorded WAV to base64."));
        return;
      }

      resolve(result.split(",", 2)[1] ?? "");
    });

    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Could not read recorded WAV."));
    });

    reader.readAsDataURL(blob);
  });
}
