/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNAL_SERVER: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
