/**
 * pi-quality-flow の既定エントリポイント。
 *
 * Phase 0A では fail-closed: finalize を持たないため、どの回答候補も置換しない。
 * candidate の識別と provenance 記録のみを行う。実モデルによる自動修正は
 * Phase 1 の適合試験が完了するまで有効化しない。
 */
import { createQualityFlowExtension } from "../src/extension.ts";

export default createQualityFlowExtension();
