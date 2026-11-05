// Runtime-agnostic core: no Node built-ins, safe to bundle with Metro for
// React Native / Expo. Everything that touches the filesystem lives in the
// Node entry point (index.js) instead.
export { scrub, SCRUB_RULES } from './scrub.js'
export {
  notesToText, parseWhatsApp, chatToConversations, parseChatJson, parseCsv,
  qaCsvToConversations, detectSourceType
} from './sources.js'
export { buildSftDataset, buildCausalDataset, toJsonl, approxTokens, datasetFingerprint } from './dataset.js'
export { PRESETS, FINETUNE_QUANTS, checkFinetunable, resolveModel } from './models.js'
export { checkFit, describeFit, ensureFits, ModelTooLargeError } from './fit.js'
export { ThinkFilter } from './think.js'
export { buildDatasetFromTexts, buildFinetuneOptions, DEFAULT_HYPER } from './build.js'
