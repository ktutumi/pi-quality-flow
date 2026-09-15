/**
 * pi-quality-flow の既定エントリポイント。
 *
 * Phase 0A〜1 では fail-closed: backend を渡さないため、どの回答候補も置換しない。
 * candidate の識別、pre gate によるローカル検証、provenance 記録のみを行う。
 * Issue #8 の Formatter pipeline（sentinel 保護 → 復元 → 構造/意味リスク検査 →
 * post gate → decideAdoption）は `createQualityFlowExtension({ backend })` で
 * 有効化され、実モデル backend の配線と適合記録の更新は #14 で行う。
 */
import { createQualityFlowExtension } from "../src/extension.ts";

export default createQualityFlowExtension();
