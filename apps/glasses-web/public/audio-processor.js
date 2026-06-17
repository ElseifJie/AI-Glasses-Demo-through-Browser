class DownsampleProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    
    const channelData = input[0];
    const sourceRate = sampleRate;
    const ratio = sourceRate / 16000;
    const newLength = Math.round(channelData.length / ratio);
    const result = new Float32Array(newLength);
    
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < channelData.length; i++) {
        sum += channelData[i];
        count++;
      }
      result[offsetResult] = count > 0 ? sum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    
    this.port.postMessage({ type: "audio", data: result.buffer }, [result.buffer]);
    return true;
  }
}

registerProcessor("downsample-processor", DownsampleProcessor);
