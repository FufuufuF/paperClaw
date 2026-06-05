export function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  } else {
    console.log(`✓ ${msg}`);
  }
}
