export interface PdfResult {
  success: boolean
  filePath?: string
  canceled?: boolean
  error?: string
}

export interface ElectronAPI {
  platform: NodeJS.Platform
  generatePdf: (html: string, defaultFilename: string) => Promise<PdfResult>
  send: (channel: string, data: unknown) => void
  receive: (channel: string, func: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
