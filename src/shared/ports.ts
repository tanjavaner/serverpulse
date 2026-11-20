/** Yalnızca makinenin içinden erişilebilen bağlama adresi mi? (127.x, [::1], localhost) */
export function isLoopbackBind(addr: string): boolean {
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|::1|localhost):/i.test(addr)
}
