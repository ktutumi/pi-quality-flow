/**
 * 出力 envelope 契約（Issue #5、前置き・レビュー文の機械的拒否）。
 *
 * 承認 prompt が出力を request 固有の nonce 付き begin/end marker で囲むよう
 * 求め、backend は marker の存在・個数・位置を検査して内側だけを返す。
 * 前置き・レビュー文・囲い・部分出力は marker の外側に現れるため
 * envelope-missing として拒否される（Issue #5 AC）。
 *
 * marker は request ごとに crypto.randomBytes で生成し、本文中への
 * 複製・指示による再現・別 request の marker 混入を
 * envelope-duplicate / envelope-unknown-marker として拒否する。
 *
 * framing は transport 専用であり、取り出した本文（採用候補）は
 * 設計書 §20 の「修正後の本文だけ。囲いの追加は禁止」契約を満たす。
 * envelope の指示は送信時に systemPrompt へ付加する固定文言で、
 * 採用本文には含まれない。
 */
import { randomBytes } from "node:crypto";

/** marker の共通 prefix。本文中にこの列が出現したら未知 marker として拒否する。 */
export const ENVELOPE_MARKER_PREFIX = "<<FMT:";

export interface Envelope {
  begin: string;
  end: string;
}

/** request 固有の envelope を生成する（cryptographically random nonce）。 */
export function createEnvelope(): Envelope {
  const nonce = randomBytes(16).toString("hex");
  return {
    begin: `${ENVELOPE_MARKER_PREFIX}beg:${nonce}>>`,
    end: `${ENVELOPE_MARKER_PREFIX}end:${nonce}>>`,
  };
}

/** 承認 prompt に付加する固定の framing 指示（transport 専用）。 */
export function envelopeInstruction(envelope: Envelope): string {
  return [
    "",
    "出力形式（必須）:",
    `出力の最初に ${envelope.begin} を書き、最後に ${envelope.end} を書いてください。`,
    "この2つのマーカーは transport 用であり、修正後の本文はマーカーの間だけに書いてください。",
    "マーカー自体、マーカーに類する文字列、前置き、レビュー、囲いを本文に含めてはいけません。",
  ].join("\n");
}

export type EnvelopeExtraction =
  | { ok: true; body: string }
  | {
      ok: false;
      code:
        | "envelope-missing"
        | "envelope-duplicate"
        | "envelope-unknown-marker"
        | "no-text-output";
    };

/**
 * raw 出力から envelope を検査して本文を取り出す（副作用のない純粋関数）。
 *
 * - begin は raw の先頭に byte-exact で1回だけ現れること（outermost）。
 * - end は raw の末尾に byte-exact で1回だけ現れること。
 * - raw 全体に marker prefix が現れるのは begin と end の2箇所だけ。
 *   それ以外の出现は本文中の複製（duplicate）または別 nonce の未知 marker。
 * - 取り出した本文が空なら no-text-output。
 */
export function extractEnvelope(raw: string, envelope: Envelope): EnvelopeExtraction {
  if (!raw.startsWith(envelope.begin) || !raw.endsWith(envelope.end)) {
    return { ok: false, code: "envelope-missing" };
  }
  const bodyStart = envelope.begin.length;
  const bodyEnd = raw.length - envelope.end.length;
  if (bodyStart > bodyEnd) {
    // begin と end が重なる（raw が極端に短い）場合も構造違反。
    return { ok: false, code: "envelope-missing" };
  }
  const body = raw.slice(bodyStart, bodyEnd);
  if (body.length === 0) return { ok: false, code: "no-text-output" };

  // marker prefix の出現箇所を数える（begin と end の2箇所以外は拒否）。
  let occurrences = 0;
  let index = raw.indexOf(ENVELOPE_MARKER_PREFIX);
  while (index !== -1) {
    occurrences += 1;
    index = raw.indexOf(ENVELOPE_MARKER_PREFIX, index + 1);
  }
  if (occurrences > 2) {
    // begin/end の位置は既に確認済みなので、3個目以降は本文中の marker。
    // 同一 nonce か別 nonce かで分類する。
    if (body.includes(envelope.begin) || body.includes(envelope.end)) {
      return { ok: false, code: "envelope-duplicate" };
    }
    return { ok: false, code: "envelope-unknown-marker" };
  }
  return { ok: true, body };
}
