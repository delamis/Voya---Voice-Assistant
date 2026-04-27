/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYSTEM_PROMPT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __LAN_ADDRESS__: string;
