const QR_VERSION = 4;
const QR_SIZE = 17 + QR_VERSION * 4;
const DATA_CODEWORDS = 80;
const ECC_CODEWORDS = 20;
const FORMAT_MASK = 0x5412;
const FORMAT_GENERATOR = 0x537;
const FORMAT_ECL_LOW = 0b01;
const PAD_CODEWORDS = [0xec, 0x11];

type QrModule = boolean | null;

export function createQrSvgDataUrl(text: string) {
  const modules = createQrModules(text);
  const quietZone = 4;
  const viewBoxSize = QR_SIZE + quietZone * 2;
  const darkPath = modules
    .flatMap((row, y) =>
      row
        .map((isDark, x) => (isDark ? `M${x + quietZone},${y + quietZone}h1v1h-1z` : ""))
        .filter(Boolean),
    )
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges">`,
    `<rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#f8fff9"/>`,
    `<path fill="#07110d" d="${darkPath}"/>`,
    "</svg>",
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createQrModules(text: string) {
  const dataCodewords = createDataCodewords(text);
  const codewords = [...dataCodewords, ...createErrorCorrectionCodewords(dataCodewords)];
  const modules = createMatrix<QrModule>(null);
  const reserved = createMatrix(false);

  drawFunctionPatterns(modules, reserved);
  drawCodewords(modules, reserved, codewords);
  applyMask(modules, reserved);
  drawFormatBits(modules, reserved);

  return modules.map((row) => row.map(Boolean));
}

function createDataCodewords(text: string) {
  const bytes = Array.from(new TextEncoder().encode(text));

  if (bytes.length > 78) {
    throw new Error("QR URL is too long for the built-in generator.");
  }

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  bytes.forEach((byte) => appendBits(bits, byte, 8));

  const capacityBits = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords: number[] = [];

  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bitsToByte(bits.slice(index, index + 8)));
  }

  for (let index = 0; codewords.length < DATA_CODEWORDS; index += 1) {
    codewords.push(PAD_CODEWORDS[index % PAD_CODEWORDS.length]);
  }

  return codewords;
}

function appendBits(bits: number[], value: number, length: number) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push((value >>> index) & 1);
  }
}

function bitsToByte(bits: number[]) {
  return bits.reduce((value, bit) => (value << 1) | bit, 0);
}

function drawFunctionPatterns(modules: QrModule[][], reserved: boolean[][]) {
  drawFinderPattern(modules, reserved, 0, 0);
  drawFinderPattern(modules, reserved, QR_SIZE - 7, 0);
  drawFinderPattern(modules, reserved, 0, QR_SIZE - 7);
  drawAlignmentPattern(modules, reserved, 26, 26);
  drawTimingPatterns(modules, reserved);
  reserveFormatAreas(modules, reserved);
  setFunctionModule(modules, reserved, 8, QR_SIZE - 8, true);
}

function drawFinderPattern(
  modules: QrModule[][],
  reserved: boolean[][],
  left: number,
  top: number,
) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const moduleX = left + x;
      const moduleY = top + y;

      if (!isInBounds(moduleX, moduleY)) {
        continue;
      }

      const isPatternCell = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      const isDark =
        isPatternCell &&
        (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));

      setFunctionModule(modules, reserved, moduleX, moduleY, isDark);
    }
  }
}

function drawAlignmentPattern(
  modules: QrModule[][],
  reserved: boolean[][],
  centerX: number,
  centerY: number,
) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunctionModule(modules, reserved, centerX + x, centerY + y, distance === 2 || distance === 0);
    }
  }
}

function drawTimingPatterns(modules: QrModule[][], reserved: boolean[][]) {
  for (let index = 8; index < QR_SIZE - 8; index += 1) {
    const isDark = index % 2 === 0;
    setFunctionModule(modules, reserved, index, 6, isDark);
    setFunctionModule(modules, reserved, 6, index, isDark);
  }
}

function reserveFormatAreas(modules: QrModule[][], reserved: boolean[][]) {
  for (let index = 0; index <= 8; index += 1) {
    if (index !== 6) {
      setFunctionModule(modules, reserved, 8, index, false);
      setFunctionModule(modules, reserved, index, 8, false);
    }
  }

  for (let index = QR_SIZE - 8; index < QR_SIZE; index += 1) {
    setFunctionModule(modules, reserved, 8, index, false);
    setFunctionModule(modules, reserved, index, 8, false);
  }
}

function drawCodewords(modules: QrModule[][], reserved: boolean[][], codewords: number[]) {
  const bits = codewords.flatMap((codeword) =>
    Array.from({ length: 8 }, (_, bitIndex) => (codeword >>> (7 - bitIndex)) & 1),
  );
  let bitIndex = 0;
  let upward = true;

  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1;
    }

    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const y = upward ? QR_SIZE - 1 - vertical : vertical;

      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;

        if (!reserved[y][x]) {
          modules[y][x] = (bits[bitIndex] ?? 0) === 1;
          bitIndex += 1;
        }
      }
    }

    upward = !upward;
  }
}

function applyMask(modules: QrModule[][], reserved: boolean[][]) {
  for (let y = 0; y < QR_SIZE; y += 1) {
    for (let x = 0; x < QR_SIZE; x += 1) {
      if (!reserved[y][x] && (x + y) % 2 === 0) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

function drawFormatBits(modules: QrModule[][], reserved: boolean[][]) {
  const formatBits = getFormatBits(FORMAT_ECL_LOW, 0);

  for (let index = 0; index <= 5; index += 1) {
    setFunctionModule(modules, reserved, 8, index, getBit(formatBits, index));
  }

  setFunctionModule(modules, reserved, 8, 7, getBit(formatBits, 6));
  setFunctionModule(modules, reserved, 8, 8, getBit(formatBits, 7));
  setFunctionModule(modules, reserved, 7, 8, getBit(formatBits, 8));

  for (let index = 9; index < 15; index += 1) {
    setFunctionModule(modules, reserved, 14 - index, 8, getBit(formatBits, index));
  }

  for (let index = 0; index < 8; index += 1) {
    setFunctionModule(modules, reserved, QR_SIZE - 1 - index, 8, getBit(formatBits, index));
  }

  for (let index = 8; index < 15; index += 1) {
    setFunctionModule(modules, reserved, 8, QR_SIZE - 15 + index, getBit(formatBits, index));
  }

  setFunctionModule(modules, reserved, 8, QR_SIZE - 8, true);
}

function getFormatBits(errorCorrectionLevel: number, maskPattern: number) {
  const data = (errorCorrectionLevel << 3) | maskPattern;
  let remainder = data << 10;

  for (let index = 14; index >= 10; index -= 1) {
    if (((remainder >>> index) & 1) !== 0) {
      remainder ^= FORMAT_GENERATOR << (index - 10);
    }
  }

  return ((data << 10) | remainder) ^ FORMAT_MASK;
}

function createErrorCorrectionCodewords(dataCodewords: number[]) {
  const generator = createGeneratorPolynomial(ECC_CODEWORDS);
  const message = [...dataCodewords, ...Array<number>(ECC_CODEWORDS).fill(0)];

  for (let index = 0; index < dataCodewords.length; index += 1) {
    const factor = message[index];

    if (factor === 0) {
      continue;
    }

    for (let offset = 1; offset < generator.length; offset += 1) {
      message[index + offset] ^= gfMultiply(generator[offset], factor);
    }
  }

  return message.slice(dataCodewords.length);
}

function createGeneratorPolynomial(degree: number) {
  let polynomial = [1];

  for (let index = 0; index < degree; index += 1) {
    polynomial = multiplyPolynomials(polynomial, [1, GF_EXP[index]]);
  }

  return polynomial;
}

function multiplyPolynomials(left: number[], right: number[]) {
  const result = Array<number>(left.length + right.length - 1).fill(0);

  left.forEach((leftValue, leftIndex) => {
    right.forEach((rightValue, rightIndex) => {
      result[leftIndex + rightIndex] ^= gfMultiply(leftValue, rightValue);
    });
  });

  return result;
}

const { GF_EXP, GF_LOG } = createGaloisFieldTables();

function createGaloisFieldTables() {
  const exp = Array<number>(512).fill(0);
  const log = Array<number>(256).fill(0);
  let value = 1;

  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    log[value] = index;
    value <<= 1;

    if ((value & 0x100) !== 0) {
      value ^= 0x11d;
    }
  }

  for (let index = 255; index < exp.length; index += 1) {
    exp[index] = exp[index - 255];
  }

  return { GF_EXP: exp, GF_LOG: log };
}

function gfMultiply(left: number, right: number) {
  if (left === 0 || right === 0) {
    return 0;
  }

  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function setFunctionModule(
  modules: QrModule[][],
  reserved: boolean[][],
  x: number,
  y: number,
  isDark: boolean,
) {
  modules[y][x] = isDark;
  reserved[y][x] = true;
}

function getBit(value: number, index: number) {
  return ((value >>> index) & 1) !== 0;
}

function createMatrix<T>(value: T) {
  return Array.from({ length: QR_SIZE }, () => Array<T>(QR_SIZE).fill(value));
}

function isInBounds(x: number, y: number) {
  return x >= 0 && x < QR_SIZE && y >= 0 && y < QR_SIZE;
}
