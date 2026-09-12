/**
 * CLI 契約試験用: env script 駆動の mock provider 拡張（-e で読み込む）。
 *
 * - `PI_QF_MOCK_SCRIPT`: mock 応答 JSON のパス
 * - `PI_QF_MOCK_CAPTURE`: request 観測の追記先（省略可）
 *
 * 本番エントリからは読み込まれない。テストのみで使用する。
 */
import { mockProviderExtension } from "./mock-provider.ts";

export default mockProviderExtension;
