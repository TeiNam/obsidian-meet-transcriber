/**
 * PCM AudioWorklet Processor
 *
 * 마이크 입력(Float32, 모노)을 수집하여 목표 샘플레이트(기본 16kHz)로
 * 다운샘플링한 뒤, Int16 리틀엔디안 PCM 청크로 변환하여 메인 스레드로 전달한다.
 *
 * AudioWorklet 스펙에 따라 본 파일은 `audioContext.audioWorklet.addModule(url)`로
 * 로드되며, `registerProcessor`로 등록된 이름("pcm-processor")을 통해
 * AudioWorkletNode와 연결된다.
 *
 * 사용 제약:
 * - 외부 import 사용 금지(브라우저 AudioWorklet 스코프는 독립 실행 환경).
 * - 이 파일은 TypeScript가 아닌 순수 JavaScript로 작성한다.
 * - 전역 `sampleRate`(AudioWorkletGlobalScope 제공)와 `AudioWorkletProcessor`를 참조한다.
 *
 * Requirements: 3.4 (PCM 16kHz/16-bit/mono 최대 200ms 간격 전송)
 */

/**
 * @typedef {Object} PcmProcessorOptions
 * @property {number} chunkMs - 한 번에 전송할 청크의 길이(밀리초). 예: 100
 * @property {number} [targetSampleRate=16000] - 다운샘플링 목표 샘플레이트(Hz).
 */

class PcmProcessor extends AudioWorkletProcessor {
    /**
     * @param {{ processorOptions?: PcmProcessorOptions }} [options]
     */
    constructor(options) {
        super();

        const opts = (options && options.processorOptions) || {};
        /** @type {number} 청크 길이(밀리초) */
        this.chunkMs = typeof opts.chunkMs === "number" && opts.chunkMs > 0 ? opts.chunkMs : 100;
        /** @type {number} 목표 샘플레이트(Hz). 예: 16000 */
        this.targetSampleRate = typeof opts.targetSampleRate === "number" && opts.targetSampleRate > 0
            ? opts.targetSampleRate
            : 16000;

        // AudioWorkletGlobalScope 가 제공하는 전역 sampleRate(입력 샘플레이트)
        /** @type {number} 입력 샘플레이트(Hz). 브라우저 기본은 보통 48000 */
        this.inputSampleRate = sampleRate;

        /**
         * 다운샘플링 비율(입력 샘플 수 / 목표 샘플 1개).
         * 48000→16000 이면 정확히 3, 44100→16000 이면 약 2.75625.
         * @type {number}
         */
        this.ratio = this.inputSampleRate / this.targetSampleRate;

        /** @type {number} 청크당 목표 샘플 개수 */
        this.samplesPerChunk = Math.max(1, Math.floor((this.chunkMs / 1000) * this.targetSampleRate));

        /** @type {Float32Array} 다운샘플링 결과를 누적하는 버퍼(목표 샘플레이트 기준) */
        this.downsampledBuffer = new Float32Array(this.samplesPerChunk);
        /** @type {number} 누적 버퍼의 다음 쓰기 위치 */
        this.downsampledIndex = 0;

        // 다운샘플링용 누적기(입력 샘플들을 ratio 개수만큼 평균하여 1샘플로 환산)
        /** @type {number} 입력 샘플 누적합 */
        this.acc = 0;
        /** @type {number} 누적된 입력 샘플 개수 */
        this.accCount = 0;
    }

    /**
     * 오디오 렌더 퀀텀(보통 128 샘플)마다 호출된다.
     *
     * 동작 흐름:
     *  1) inputs[0][0] 에서 모노 Float32 샘플 배열을 꺼낸다.
     *  2) ratio 개수만큼 누적 평균하여 다운샘플링된 샘플 1개를 생성한다.
     *  3) 다운샘플링 버퍼가 samplesPerChunk 에 도달하면 Int16 리틀엔디안 PCM으로 변환하여
     *     메인 스레드로 postMessage 한다(ArrayBuffer 는 Transferable 로 이전).
     *  4) true 를 반환하여 노드가 살아 있도록 유지한다.
     *
     * @param {Float32Array[][]} inputs - inputs[channelCount][...][sampleCount]
     * @returns {boolean} 항상 true (프로세서 유지)
     */
    process(inputs) {
        const input = inputs && inputs[0];
        if (!input || input.length === 0) {
            return true;
        }
        // 첫 번째 채널만 사용(모노 전사 파이프라인 기준)
        const channel = input[0];
        if (!channel || channel.length === 0) {
            return true;
        }

        for (let i = 0; i < channel.length; i++) {
            this.acc += channel[i];
            this.accCount += 1;

            // 다운샘플링: ratio 이상 누적되면 평균을 취해 목표 샘플 1개 생성
            if (this.accCount >= this.ratio) {
                const downsampled = this.acc / this.accCount;
                this.downsampledBuffer[this.downsampledIndex++] = downsampled;
                this.acc = 0;
                this.accCount = 0;

                // 청크가 가득 차면 Int16 PCM 으로 변환 후 전달
                if (this.downsampledIndex >= this.samplesPerChunk) {
                    this._flushChunk();
                }
            }
        }

        return true;
    }

    /**
     * 누적된 Float32 샘플(-1.0 ~ +1.0)을 Int16 PCM(-32768 ~ +32767) 리틀엔디안으로
     * 변환하여 메인 스레드로 전송한다. ArrayBuffer 는 Transferable 목록에 포함되어
     * 복사 없이 이전된다.
     *
     * @private
     */
    _flushChunk() {
        const length = this.samplesPerChunk;
        const int16 = new Int16Array(length);

        for (let j = 0; j < length; j++) {
            // [-1, 1] 범위로 클램프 후 비대칭 스케일링 (WebAudio 관례)
            let s = this.downsampledBuffer[j];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            int16[j] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }

        // Transferable 로 넘겨 복사 비용 회피. 메인 스레드는 ArrayBuffer 로 수신한다.
        this.port.postMessage(int16.buffer, [int16.buffer]);

        this.downsampledIndex = 0;
    }
}

registerProcessor("pcm-processor", PcmProcessor);
