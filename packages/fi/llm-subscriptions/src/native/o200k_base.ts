/**
 * Lazy chunk boundary for the offline o200k tokenizer: the bundled vocabulary and
 * the two internals the incremental output budget reads, loaded only for capped calls.
 */
export { decode, encode, setMergeCacheSize } from 'gpt-tokenizer/encoding/o200k_base'
export { decoder } from 'gpt-tokenizer/BytePairEncodingCore'
export { O200K_TOKEN_SPLIT_REGEX } from 'gpt-tokenizer/encodingParams/constants'
