/** js-yaml ships no types and is used by two scripts only; `load` is all they call. */
declare module 'js-yaml' {
  export function load(text: string): unknown
  const yaml: { load(text: string): unknown }
  export default yaml
}
