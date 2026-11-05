// QVAC fine-tuning supports a subset of chat models:
//   architecture: qwen3, gemma3 or bitnet
//   quantisation: F32, F16, Q4_0, Q8_0, TQ1_0 or TQ2_0
// (https://docs.qvac.tether.io/sdk/ai-capabilities/fine-tuning). Many catalog
// constants are Q4_K_M and will fail, so check before downloading.

export const FINETUNE_QUANTS = ['F32', 'F16', 'Q4_0', 'Q8_0', 'TQ1_0', 'TQ2_0']

/** Presets ordered small → large. `phone` = comfortable on a recent phone. */
export const PRESETS = {
  tiny: { constant: 'QWEN3_600M_INST_Q4', label: 'Qwen3 0.6B (Q4_0, 382 MB)', phone: true, mode: 'sft' },
  small: { constant: 'QWEN3_1_7B_INST_Q4', label: 'Qwen3 1.7B (Q4_0, 1.1 GB)', phone: true, mode: 'sft' },
  bitnet: { constant: 'BITNET_0_7B_BASE_TQ2_0', label: 'BitNet b1.58 0.7B (TQ2_0, 217 MB, base model)', phone: true, mode: 'causal' },
  'bitnet-1b': { constant: 'BITNET_1B_BASE_TQ2_0', label: 'BitNet b1.58 1B (TQ2_0, 835 MB, base model)', phone: true, mode: 'causal' },
  'bitnet-3b': { constant: 'BITNET_B1_58_3B_BASE_TQ2_0', label: 'BitNet b1.58 3B (TQ2_0, 1.9 GB, base model)', phone: false, mode: 'causal' }
}

/**
 * Check a model descriptor (an SDK constant) or a local file name.
 * @param {{ name?: string, registryPath?: string } | string} model
 * @returns {{ ok: boolean, arch: string|null, quant: string|null, reason?: string }}
 */
export function checkFinetunable (model) {
  const name = typeof model === 'string' ? model : (model.registryPath ?? model.name ?? '')
  const file = name.split('/').pop()
  const lower = file.toLowerCase()

  // Qwen3.5/3.6/3.8 are different architectures (qwen35, …), not qwen3.
  const arch = /qwen3(?![._-]?[5-9])/.test(lower)
    ? 'qwen3'
    : /gemma[-_]?3/.test(lower)
      ? 'gemma3'
      : /bitnet/.test(lower) ? 'bitnet' : null
  const qm = file.match(/(?:^|[-_.])(F32|F16|BF16|Q\d_K(?:_[A-Z]+)?|Q\d_\d|TQ\d_\d|IQ\d_[A-Z]+)(?=\.gguf$|[-_.])/i)
  const quant = qm ? qm[1].toUpperCase() : null

  if (!arch) return { ok: false, arch, quant, reason: `architecture not supported for fine-tuning (${file}); use a qwen3, gemma3 or bitnet model` }
  if (!quant) return { ok: false, arch, quant, reason: `could not determine quantisation from "${file}"` }
  if (!FINETUNE_QUANTS.includes(quant)) {
    return { ok: false, arch, quant, reason: `${quant} cannot be fine-tuned; pick one of ${FINETUNE_QUANTS.join(', ')}` }
  }
  return { ok: true, arch, quant }
}

/** Resolve "tiny" | "QWEN3_600M_INST_Q4" | "./model.gguf" to an SDK modelSrc. */
export function resolveModel (spec, sdk) {
  const preset = PRESETS[spec]
  const constName = preset?.constant ?? spec
  if (/^[A-Z0-9_]+$/.test(constName)) {
    const descriptor = sdk?.[constName]
    if (!descriptor) throw new Error(`Unknown QVAC model constant ${constName}`)
    return { modelSrc: descriptor, name: constName, check: checkFinetunable(descriptor), preset }
  }
  return { modelSrc: spec, name: spec.split('/').pop(), check: checkFinetunable(spec), preset }
}
