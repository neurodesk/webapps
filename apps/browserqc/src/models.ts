import catalog from './models.json' with { type: 'json' }

export const MODELS = catalog
export type Model = keyof typeof MODELS
export function parseModel(value: unknown): Model {
  switch (value) {
    case '16chan18cls':
    case 'mindmap':
    case 'mindsnap':
    case 'mindmap-pve':
      return value
    default:
      throw new Error('Choose a supported BrowserQC segmentation model.')
  }
}
