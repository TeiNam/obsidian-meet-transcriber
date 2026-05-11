/**
 * `?worklet` 쿼리 import 에 대한 TypeScript 앰비언트 선언.
 *
 * `esbuild.config.mjs` 의 `workletTextPlugin` 이 이 쿼리가 붙은 import 를 가로채
 * 파일 내용을 문자열로 export 한다. TypeScript 에는 이 번들 단계 마법이 보이지 않으므로
 * 여기서 타입만 선언한다.
 */
declare module "*?worklet" {
	const source: string;
	export default source;
}
