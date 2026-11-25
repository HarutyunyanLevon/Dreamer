export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** A small LCS-based line diff; good enough for comparing short card bodies side by side. */
export function diffLines(base: string, other: string): DiffLine[] {
  const a = base.split("\n");
  const b = other.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** `git diff` output as the same lines (the file headers and hunk markers are dropped). */
export function parseUnified(text: string): DiffLine[] {
  return text
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(l))
    .map((l): DiffLine => (l.startsWith("@@") ? { kind: "same", text: "…" } : l.startsWith("+") ? { kind: "add", text: l.slice(1) } : l.startsWith("-") ? { kind: "del", text: l.slice(1) } : { kind: "same", text: l.slice(1) }));
}
