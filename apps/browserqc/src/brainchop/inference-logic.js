import * as tf from '@tensorflow/tfjs'

import {
  applyMriThreshold,
  convByOutputChannelAndInputSlicing,
  gn_convByOutputChannelAndInputSlicing,
  convChannelList,
  convTransposeChannelList,
  seqConvArgMaxChannelList,
  splitToChannelList,
  LayerNormInPlace,
  firstLastNonZero3D,
  cropAndGetCorner,
  restoreToOriginalSize,
  isModelChnlLast,
  minMaxNormalizeVolumeData,
  quantileNormalizeVolumeData,
  processSegmentationVolume,
  SequentialConvLayer,
  checkMemoryAllocation,
  estimateMaxIntermediateTensorSize
} from './tensor-utils.js';

import {
  markSuccess,
  markFailure,
  addLabelStats
} from './diagnostic-stats.js';

// --- PROFILING TOGGLE -----------------------------------------------------
// When true, force a GPU readback + wall-clock log after EVERY layer so we can
// see the real per-layer cost (which layers dominate) and rule the GPU sync in
// or out. This itself adds a sync per layer, so only use it for a measurement
// run; set back to false for normal use.
const DEBUG_LAYER_TIMING = false;

// Per-layer console logging is surprisingly expensive in the hot loop when
// devtools is open (each call serializes a tensor shape). Keep it off for
// normal/fast runs; flip on only when debugging correctness.
const VERBOSE_LAYER_LOGGING = false;
// --------------------------------------------------------------------------

export async function runFullVolumeInference(
  opts,
  modelEntry,
  model,
  slices_3d,
  pipeline1_out,
  statData,
  callbackImg,
  callbackUI,
  niftiImage
) {
  // --- TIMER START (Total Execution) ---
  const totalExecutionStartTime = performance.now();
  // --- 1. UNIFIED SETUP (Identical for both methods) ---
  console.log(`---- Start FullVolume Inference (SeqConv: ${modelEntry.enableSeqConv}) ----`);
  // Normalization
  if (modelEntry.enableQuantileNorm) {
    console.log('preModel Quantile normalization enabled');
    slices_3d = await quantileNormalizeVolumeData(slices_3d);
  } else {
    console.log('preModel Min Max normalization enabled');
    slices_3d = await minMaxNormalizeVolumeData(slices_3d);
  }

  // Masking
  let mask_3d;
  if (pipeline1_out == null) {
    const autoThresholdValue = modelEntry.autoThreshold;
    if (autoThresholdValue > 0 && autoThresholdValue <= 1) {
      mask_3d = await applyMriThreshold(slices_3d, autoThresholdValue);
    } else {
      mask_3d = await slices_3d.greater([0]).asType('bool');
    }
  } else {
    mask_3d = await pipeline1_out.greater([0]).asType('bool');
  }

  // Capture original dimensions for restoration
  const originalVolumeShape = slices_3d.shape;

  // WebGL-path-only transpose override. Some models' tfjs (WebGL) export expects
  // a DIFFERENT input orientation than their WebGPU (safetensors) export. When
  // modelEntry.webglEnableTranspose is defined it overrides enableTranspose for
  // THIS (WebGL) path only; the WebGPU path (inference-webgpu.js) always uses
  // modelEntry.enableTranspose. Example: Tissue GWM (id 7) needs transpose ON for
  // WebGPU but OFF for WebGL -- with it on, WebGL feeds the tfjs model the wrong
  // orientation and the segmentation degrades to noise.
  const webglEnableTranspose = (modelEntry.webglEnableTranspose !== undefined)
    ? modelEntry.webglEnableTranspose
    : modelEntry.enableTranspose;

  // Cropping and Padding
  // Cropping and Padding
  const pad = modelEntry.cropPadding;
  let cropped_slices_3d_w_pad, refVoxel, padInfo;

  if (modelEntry.enableCrop) {
    const cropResult = await cropAndGetCorner(slices_3d, mask_3d, pad);
    cropped_slices_3d_w_pad = cropResult.cropped;
    refVoxel = cropResult.corner;
    padInfo = cropResult.padding;
    slices_3d.dispose();
  } else {
    console.log('Skipping cropping (enableCrop: false)');
    // Enforce Even Dimensions (Model Requirement)
    const shape = slices_3d.shape;
    const padRow = shape[0] % 2;
    const padCol = shape[1] % 2;
    const padDepth = shape[2] % 2;

    if (padRow || padCol || padDepth) {
      console.log(`Padding standard input to even: ${shape} -> +[${padRow}, ${padCol}, ${padDepth}]`);
      cropped_slices_3d_w_pad = slices_3d.pad([[0, padRow], [0, padCol], [0, padDepth]]);
      padInfo = [padRow, padCol, padDepth]; // Scalars, compatible with unpadding logic
      slices_3d.dispose();
    } else {
      cropped_slices_3d_w_pad = slices_3d;
      padInfo = null;
    }
    refVoxel = [0, 0, 0];
    // Do NOT dispose slices_3d if took ownership
  }

  mask_3d.dispose();

  if (modelEntry.inputPermutation) {
    console.log(`Permuting Input: ${modelEntry.inputPermutation}`);
    cropped_slices_3d_w_pad = cropped_slices_3d_w_pad.transpose(modelEntry.inputPermutation);
  } else if (webglEnableTranspose) {
    cropped_slices_3d_w_pad = cropped_slices_3d_w_pad.transpose();
    console.log('Input transposed for pre-model');
  }

  // --- 2. UNIFIED MODEL & TENSOR PREPARATION ---
  const res = await model;
  const layersLength = res.layers.length;
  const isChannelLast = isModelChnlLast(res);

  // Debug: Log Activations (one-time; gated to avoid console overhead)
  if (VERBOSE_LAYER_LOGGING) {
    console.log("--- Model Architecture Debug ---");
    res.layers.forEach((l, idx) => {
      let act = "unknown";
      try {
        act = l.activation ? l.activation.getClassName() : (l.activation === null ? "null (linear?)" : "none");
        // Some layers like InputLayer don't have activation
      } catch (e) { }
      console.log(`Layer ${idx}: ${l.name} (${l.getClassName()}) -> Activation: ${act}`);
    });
    console.log("--------------------------------");
  }

  // Adjust model input shape (common logic)
  let adjusted_input_shape;
  if (isChannelLast) {
    res.layers[0].batchInputShape[1] = cropped_slices_3d_w_pad.shape[0];
    res.layers[0].batchInputShape[2] = cropped_slices_3d_w_pad.shape[1];
    res.layers[0].batchInputShape[3] = cropped_slices_3d_w_pad.shape[2];
    adjusted_input_shape = [opts.batchSize, res.layers[0].batchInputShape[1], res.layers[0].batchInputShape[2], res.layers[0].batchInputShape[3], opts.numOfChan];
  } else {
    res.layers[0].batchInputShape[2] = cropped_slices_3d_w_pad.shape[0];
    res.layers[0].batchInputShape[3] = cropped_slices_3d_w_pad.shape[1];
    res.layers[0].batchInputShape[4] = cropped_slices_3d_w_pad.shape[2];
    adjusted_input_shape = [opts.batchSize, opts.numOfChan, res.layers[0].batchInputShape[2], res.layers[0].batchInputShape[3], res.layers[0].batchInputShape[4]];
  }

  let currentOutputTensor = cropped_slices_3d_w_pad.reshape(adjusted_input_shape);

  // --- PROACTIVE MEMORY CHECK (Centralized) ---
  // Check for two conditions:
  // 1. PACKED check fails (intermediates too large) → full SeqConv fallback
  // 2. UNPACKED check fails (final output too large) → use chunkedArgMax
  let useChunkedArgMax = false;

  if (!modelEntry.enableSeqConv) {
    const { peak, maxOutput } = estimateMaxIntermediateTensorSize(res, adjusted_input_shape, isChannelLast);
    console.log(`[Centralized Check] Peak (In+Out): ${peak}, Max Output: ${maxOutput}`);

    const backend = tf.backend();
    const maxTextureSize = (backend && backend.gpgpu && backend.gpgpu.gl)
      ? backend.gpgpu.gl.getParameter(backend.gpgpu.gl.MAX_TEXTURE_SIZE)
      : 16384;

    console.log(`[Memory Check] MAX_TEXTURE_SIZE from WebGL context: ${maxTextureSize}`);

    // Check PACKED (intermediates) - if this fails, need full SeqConv
    const packedDim = Math.ceil(Math.sqrt(Math.ceil(peak / 4)));
    // Check UNPACKED (final output) - if only this fails, use chunked argmax
    const unpackedDim = Math.ceil(Math.sqrt(maxOutput));

    if (packedDim > maxTextureSize) {
      console.warn(`[Memory Check] PACKED intermediates too large (${packedDim} > ${maxTextureSize}). Using full SeqConv.`);
      modelEntry.enableSeqConv = true;
    } else if (unpackedDim > maxTextureSize) {
      console.warn(`[Memory Check] UNPACKED output too large (${unpackedDim} > ${maxTextureSize}). Using chunkedArgMax.`);
      useChunkedArgMax = true;
    } else {
      console.log(`[Memory Check] All checks passed. Using fast path.`);
    }
  }

  // --- ONE-LINE PATH SUMMARY (always logged) ---------------------------------
  // Read this single line to know exactly what is about to run. If PATH=SeqConv
  // (or you see a later "retrying with enableSeqConv: true" from main.js), that
  // is the 80s+ crawl. Fast path should read PATH=fast(+chunkedArgMax).
  const _pathName = modelEntry.enableSeqConv
    ? 'SeqConv (SLOW: per-channel conv + sync every layer)'
    : (useChunkedArgMax ? 'fast + chunkedArgMax (final layer only)' : 'fast (dense)');
  console.log(`%c[PATH] ${_pathName}  | crop=${cropped_slices_3d_w_pad.shape}  | enableCrop=${modelEntry.enableCrop} cropPadding=${modelEntry.cropPadding}`,
    'font-weight:bold;color:#0a0');
  // ---------------------------------------------------------------------------

  async function runModelInferenceLoop(res, inputTensor, loopEnd, layersLength, modelEntry, statData, callbackUI) {
    let i = 1;
    let currentOutputTensor = inputTensor;

    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    let SYNC_GPU_EVERY_N_LAYERS = (isSafari || isFirefox) ? 10 : 15;
    if (modelEntry.enableSeqConv) {
      SYNC_GPU_EVERY_N_LAYERS = 1;
    }
    console.log(`Syncing GPU every ${SYNC_GPU_EVERY_N_LAYERS} layers.`);

    while (i <= loopEnd) {
      const _layerStart = performance.now();
      let _splitMsg = '';
      try {
        let nextTensor;
        // Only linear Conv3D layers may use the memory-frugal slice-conv path.
        // In the affine-GN models a 1x1x1 Conv3D ("affine_*") carries the learned
        // per-channel gamma*x+beta and GELU is a separate Activation layer. Both are
        // handled fine here (the affine conv is a real linear Conv3D; activations
        // fall through to layer.apply). Guarding on getClassName()==='Conv3D' also
        // avoids reading `.activation` on layers that don't define it.
        const _layer = res.layers[i];
        const _act = _layer.activation;
        const _isLinearConv = _layer.getClassName() === 'Conv3D' && _act && _act.getClassName() === 'linear';
        if (modelEntry.enableSeqConv && _isLinearConv) {
          const convFunction = res.layers[i].name.endsWith('_gn')
            ? gn_convByOutputChannelAndInputSlicing
            : convByOutputChannelAndInputSlicing;

          nextTensor = await convFunction(
            currentOutputTensor,
            res.layers[i].getWeights()[0],
            res.layers[i].getWeights()[1],
            res.layers[i].strides,
            res.layers[i].padding,
            res.layers[i].dilationRate,
            3
          );
        } else if (DEBUG_LAYER_TIMING && res.layers[i].name.endsWith('_gn')) {
          // Timed split: isolate the dilated conv from the manual per-channel
          // z-score (LayerNormInPlace). Forces a GPU sync after each so the ms
          // reflect real compute. Use only for a measurement run.
          const _c0 = performance.now();
          const convOut = tf.tidy(() => res.layers[i].apply(currentOutputTensor));
          { const _fe = convOut.slice([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]); await _fe.data(); _fe.dispose(); }
          const _convMs = (performance.now() - _c0).toFixed(1);

          const _n0 = performance.now();
          nextTensor = LayerNormInPlace(convOut);
          convOut.dispose();
          { const _fe = nextTensor.slice([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]); await _fe.data(); _fe.dispose(); }
          const _normMs = (performance.now() - _n0).toFixed(1);
          _splitMsg = `  [conv=${_convMs}ms  norm=${_normMs}ms]`;
        } else {
          nextTensor = tf.tidy(() => {
            let resultTensor = res.layers[i].apply(currentOutputTensor);
            if (res.layers[i].name.endsWith('_gn')) {
              resultTensor = LayerNormInPlace(resultTensor);
            }
            return resultTensor;
          });
        }

        currentOutputTensor.dispose();
        currentOutputTensor = nextTensor;

      } catch (err) {
        callbackUI(err.message, -1, err.message);
        tf.engine().endScope();
        tf.engine().disposeVariables();
        markFailure(statData, err, 'Failed while model layer ' + i + ' apply');
        callbackUI('', -1, '', statData);
        throw err;
      }

      if (DEBUG_LAYER_TIMING) {
        // Force this layer to finish so the elapsed time reflects real compute.
        const firstElement = currentOutputTensor.slice([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]);
        await firstElement.data();
        firstElement.dispose();
        const _ms = (performance.now() - _layerStart).toFixed(1);
        const _l = res.layers[i];
        const _dil = _l.dilationRate ? `dil=${Array.isArray(_l.dilationRate) ? _l.dilationRate[0] : _l.dilationRate}` : '';
        console.log(`[layer-timing] L${i} ${_l.name} ${_dil} -> ${_ms} ms${_splitMsg}  shape=${currentOutputTensor.shape}`);
        callbackUI('Layer ' + i.toString(), (i + 1) / layersLength);
      } else if (i % SYNC_GPU_EVERY_N_LAYERS === 0) {
        if (VERBOSE_LAYER_LOGGING) console.log(`Layer ${i}... (Syncing GPU)`);
        callbackUI('Layer ' + i.toString(), (i + 1) / layersLength);
        const firstElement = currentOutputTensor.slice([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]);
        await firstElement.data();
        firstElement.dispose();
      } else {
        callbackUI('Layer ' + i.toString(), (i + 1) / layersLength);
      }

      if (VERBOSE_LAYER_LOGGING) console.log(`Layer ${i} output shape: `, currentOutputTensor.shape);
      i++;
    }
    return currentOutputTensor;
  }

  // --- CHANNEL-LIST INFERENCE LOOP (memory-frugal WebGL2 path) ---------------
  // Threads the activation through the backbone as an ARRAY of single-channel
  // [1, D, H, W, 1] tensors, so no [1, D, H, W, C] intermediate is ever built
  // (which would exceed WebGL2's 8192 texture limit for the big models).
  // Layer handling is driven off topology (class name + activation), not
  // hardcoded indices, so any MeshNet model works:
  //   - Conv3D (linear): channel-list conv; if name ends with `_gn`, fuse the
  //     per-channel instance-norm (GroupNorm decomposed) into each output channel.
  //   - Activation (gelu/relu/elu/...): elementwise map over the channel-list.
  // Returns the backbone output as a channel-list (caller runs the final layer).
  async function runChannelListInferenceLoop(res, inputTensor, loopEnd, layersLength, modelEntry, statData, callbackUI) {
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    const SYNC_GPU_EVERY_N_LAYERS = (isSafari || isFirefox) ? 4 : 6;

    // Split the (single- or multi-channel) input into a channel-list. For the
    // 1-channel input this takes ownership of inputTensor (no copy); it is
    // disposed when layer 1 produces the next list.
    let currentList = splitToChannelList(inputTensor);

    let i = 1;
    while (i <= loopEnd) {
      try {
        const layer = res.layers[i];
        const cn = layer.getClassName();
        const act = layer.activation;
        let nextList;

        if (cn === 'Conv3D' && act && act.getClassName() === 'linear') {
          // Linear Conv3D: dilated backbone conv (`_gn` -> fuse instance norm),
          // the diagonal 1x1 affine conv, or a strided/downsample conv. All go
          // through the same channel-list conv (stride/dilation/bias honored).
          const isGN = layer.name.endsWith('_gn');
          nextList = convChannelList(
            currentList,
            layer.getWeights()[0],
            layer.getWeights()[1],
            layer.strides,
            layer.padding,
            layer.dilationRate,
            3,
            isGN
          );
        } else if (cn === 'Activation') {
          // Elementwise activation -> map over the channel-list.
          nextList = currentList.map((t) => tf.tidy(() => layer.apply(t)));
        } else if (cn === 'Conv3D') {
          // Conv3D whose built-in activation is non-linear: do the linear conv
          // via the channel-list, then apply the activation per channel.
          nextList = convChannelList(
            currentList,
            layer.getWeights()[0],
            layer.getWeights()[1],
            layer.strides,
            layer.padding,
            layer.dilationRate,
            3,
            false
          );
          const activated = nextList.map((t) => tf.tidy(() => layer.activation.apply(t)));
          tf.dispose(nextList);
          nextList = activated;
        } else if (cn === 'Conv3DTranspose') {
          // Strided up-sampling conv (SpatialAE decoder, e.g. Tissue GWM SAE).
          // Compute the output spatial dims from the layer itself (robust to
          // any stride/kernel/padding), then run the channel-list transpose conv.
          const inSpatial = [currentList[0].shape[1], currentList[0].shape[2], currentList[0].shape[3]];
          const outShape = layer.computeOutputShape([1, inSpatial[0], inSpatial[1], inSpatial[2], currentList.length]);
          const outSpatial = [outShape[1], outShape[2], outShape[3]];
          nextList = convTransposeChannelList(
            currentList,
            layer.getWeights()[0],
            layer.getWeights()[1],
            outSpatial,
            layer.strides,
            layer.padding
          );
          // Apply the layer's activation per channel if it's non-linear.
          if (layer.activation && layer.activation.getClassName() !== 'linear') {
            const activated = nextList.map((t) => tf.tidy(() => layer.activation.apply(t)));
            tf.dispose(nextList);
            nextList = activated;
          }
        } else {
          throw new Error(`Channel-list path: unsupported layer ${cn} (${layer.name})`);
        }

        // Dispose the previous layer's list as soon as the next is produced.
        tf.dispose(currentList);
        currentList = nextList;
      } catch (err) {
        tf.dispose(currentList);
        callbackUI(err.message, -1, err.message);
        tf.engine().endScope();
        tf.engine().disposeVariables();
        markFailure(statData, err, 'Failed while model layer ' + i + ' apply (channel-list)');
        callbackUI('', -1, '', statData);
        throw err;
      }

      callbackUI('Layer ' + i.toString(), (i + 1) / layersLength);
      if (i % SYNC_GPU_EVERY_N_LAYERS === 0) {
        // Periodic GPU sync on a single channel keeps the command queue bounded
        // without ever reading back a full multi-channel tensor.
        const firstElement = currentList[0].slice([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]);
        await firstElement.data();
        firstElement.dispose();
      }
      i++;
    }
    return currentList;
  }

  // --- 3. MAIN INFERENCE (TTA Enabled) ---
  const startTime = performance.now();
  const skipFinalLayer = modelEntry.enableSeqConv || useChunkedArgMax;
  const loopEnd = skipFinalLayer ? layersLength - 2 : layersLength - 1;



  // --- 3/4. INFERENCE + FINAL PROCESSING (path-dependent) ---
  let outLabelVolume;

  if (modelEntry.enableSeqConv) {
    // ===== CHANNEL-LIST PATH (memory-frugal, WebGL2 texture-safe) ============
    // The backbone activation is carried as an array of single-channel tensors,
    // so no full [1, D, H, W, C] intermediate is ever materialized. This is the
    // path used when the dense/packed path would exceed WebGL2's 8192 texture
    // limit (the big gridding-free models: 24ch/104cls, 32ch/18cls).
    if (modelEntry.enableTTA) {
      console.warn('[channel-list] TTA is not supported on the channel-list path; running a single pass.');
    }
    const backboneList = await runChannelListInferenceLoop(
      res, currentOutputTensor, loopEnd, layersLength, modelEntry, statData, callbackUI
    );
    cropped_slices_3d_w_pad.dispose();

    // Final classifier + incremental argmax, straight from the channel-list
    // (never builds the full [.,numClasses] logits tensor).
    console.log('Applying channel-list final classifier + argmax...');
    const finalLayer = res.layers[layersLength - 1];
    const isWebWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
    const argmaxVolume = await seqConvArgMaxChannelList(
      backboneList,
      finalLayer.getWeights()[0],
      finalLayer.getWeights()[1],
      finalLayer.strides,
      finalLayer.padding,
      finalLayer.dilationRate,
      callbackUI,
      isWebWorker
    );
    tf.dispose(backboneList);
    outLabelVolume = argmaxVolume.asType('int32');
    argmaxVolume.dispose();
    console.log('Channel-list argmax output shape:', outLabelVolume.shape);

  } else {
    // ===== DENSE PATH (fast packed path; optional chunked final argmax) ======
    if (modelEntry.enableTTA) {
      console.log('--- Running TTA Pass 1 (Original) ---');
      // input1 is the reshaped 5D tensor
      const input1 = currentOutputTensor;
      // Note: runModelInferenceLoop disposes input1.
      const logits1 = await runModelInferenceLoop(res, input1, loopEnd, layersLength, modelEntry, statData, callbackUI);

      if (!logits1) throw new Error("TTA Error: logits1 is null or undefined");

      console.log('--- Running TTA Pass 2 (Flipped) ---');
      const flipAxis = modelEntry.ttaFlipAxis || 1;
      // input2 must be 5D. Reverse 3D then reshape.
      const input2 = cropped_slices_3d_w_pad.clone().reverse(flipAxis).reshape(adjusted_input_shape);
      const logits2 = await runModelInferenceLoop(res, input2, loopEnd, layersLength, modelEntry, statData, callbackUI);

      if (!logits2) throw new Error("TTA Error: logits2 is null or undefined");

      console.log('--- Averaging TTA Results ---');
      // WebGL cannot reverse rank-5 tensors. Reshape to 4D -> Reverse -> Reshape back.
      const logits2_flipped = tf.tidy(() => {
        const shape = logits2.shape; // [B, D, H, W, C]
        // Flatten B and D to create 4D [B*D, H, W, C]. Axis mapping works for 0,1,2.
        return logits2.reshape([shape[0] * shape[1], shape[2], shape[3], shape[4]])
          .reverse(flipAxis)
          .reshape(shape);
      });

      // Use instance method to avoid potential issue with tf.add shim
      currentOutputTensor = logits1.add(logits2_flipped).div(2.0);

      logits1.dispose();
      logits2.dispose();
      logits2_flipped.dispose();
      // input1/input2 disposed by loop logic
      cropped_slices_3d_w_pad.dispose();
    } else {
      // Standard execution: Use the 5D tensor prepared above
      currentOutputTensor = await runModelInferenceLoop(res, currentOutputTensor, loopEnd, layersLength, modelEntry, statData, callbackUI);
      cropped_slices_3d_w_pad.dispose();
    }

    if (useChunkedArgMax) {
      // --- FINAL PROCESSING WITH CHUNKED FINAL LAYER (Fast Path + Safe Final Conv/ArgMax) ---
      // The final conv layer (e.g., 30→50 channels) would create a 50-channel output
      // that exceeds texture limits when unpacked for argmax. Use SequentialConvLayer
      // for ONLY the final layer, which chunks both conv and argmax operations.
      console.log('Applying SequentialConvLayer for final layer only (fast path for layers 1-18)...');
      const seqConvLayer = new SequentialConvLayer(res, 10, isChannelLast, callbackUI);
      const seqConvResult = await seqConvLayer.apply(currentOutputTensor);
      outLabelVolume = seqConvResult.asType('int32');
      seqConvResult.dispose();
      currentOutputTensor.dispose();
      console.log('SequentialConvLayer (final only) output shape:', outLabelVolume.shape);

    } else {
      // --- FINAL PROCESSING FOR STANDARD METHOD ---
      console.log('Applying final ArgMax...');
      outLabelVolume = tf.tidy(() => {
        const axis = isChannelLast ? -1 : 1;
        const prediction_argmax = tf.argMax(currentOutputTensor, axis);
        return tf.squeeze(prediction_argmax);
      });
      currentOutputTensor.dispose(); // The tidy already disposed the original, but this is safe
      console.log('ArgMax output shape:', outLabelVolume.shape);
    }
  }

  // --- 5. UNIFIED POST-PROCESSING & OUTPUT GENERATION ---
  const Inference_t = ((performance.now() - startTime) / 1000).toFixed(4);
  // --- Log the inference time ---
  console.log(`---- Inference Time: ${Inference_t} seconds ----`);

  // Transpose back if needed
  if (modelEntry.outputPermutation) {
    console.log(`Permuting Output: ${modelEntry.outputPermutation}`);
    outLabelVolume = outLabelVolume.transpose(modelEntry.outputPermutation);
  } else if (webglEnableTranspose) {
    console.log('outLabelVolume transposed');
    outLabelVolume = outLabelVolume.transpose();
  }

  //Restore to original volume size
  const PaddingStartTime = performance.now();
  // Remove padding if it was added for even dimensions
  if (padInfo && (padInfo[0] || padInfo[1] || padInfo[2])) {
    const shape = outLabelVolume.shape;
    const newShape = [
      shape[0] - padInfo[0],
      shape[1] - padInfo[1],
      shape[2] - padInfo[2]
    ];
    const unpadded = outLabelVolume.slice([0, 0, 0], newShape);
    outLabelVolume.dispose();
    outLabelVolume = unpadded;
    console.log(`Removed padding: [${shape}] -> [${outLabelVolume.shape}]`);
  }

  console.log('outLabelVolume without padding shape: ', outLabelVolume.shape);
  outLabelVolume = await restoreToOriginalSize(outLabelVolume, refVoxel, originalVolumeShape, modelEntry.outputShift);
  console.log('outLabelVolume final shape after restoration: ', outLabelVolume.shape);
  const Padding_t = ((performance.now() - PaddingStartTime) / 1000).toFixed(4);
  console.log(`---- Restoration Time: ${Padding_t} seconds ----`);

  const postProcessStartTime = performance.now();
  let outimg;
  try {
    outimg = await processSegmentationVolume(outLabelVolume, niftiImage, modelEntry, opts);
  } catch (err) {
    // Postprocessing can deliberately bail out on a noise/garbage segmentation
    // (err.code === 'SEGMENTATION_NOISE') instead of freezing the tab on the
    // O(cl^2) component filtering. Surface it the same way layer failures are
    // surfaced, then re-throw so the worker stops cleanly.
    callbackUI(err.message, -1, err.message);
    markFailure(statData, err, 'Failed during segmentation post-processing');
    callbackUI('', -1, '', statData);
    outLabelVolume.dispose();
    tf.engine().disposeVariables();
    throw err;
  }
  const Postprocess_t = ((performance.now() - postProcessStartTime) / 1000).toFixed(4);
  console.log(`---- Postprocessing Time: ${Postprocess_t} seconds ----`);


  outLabelVolume.dispose();
  tf.engine().disposeVariables();


  // --- TIMER END (Total Execution) ---
  const totalExecutionTime = ((performance.now() - totalExecutionStartTime) / 1000).toFixed(4);
  // --- Log the total execution time ---
  console.log(`---- Total Execution Time: ${totalExecutionTime} seconds ----`);

  // Calculate label stats before disposal
  const uniqueLabels = new Set(outimg);
  const actualLabels = uniqueLabels.size;
  const expectedLabels = modelEntry.numClasses || actualLabels;
  addLabelStats(statData, expectedLabels, actualLabels);

  markSuccess(statData, Inference_t, Postprocess_t);
  callbackUI(modelEntry.modelName + '<br>Segmentation finished', 0);
  callbackUI('', -1, '', statData);
  callbackImg(outimg, opts, modelEntry);

  return 0;
}
