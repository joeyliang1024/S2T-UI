import type { UiLanguage } from './index'

/**
 * Service copy: user-visible errors and labels raised outside the view layer
 * (shared services, model adapter, transcript export …). Keys are prefixed
 * with `svc` so they never collide with view or status keys. One entry per
 * user-visible string, always complete across every supported language.
 */
export const serviceMessages: Record<string, Record<UiLanguage, string>> = {
  svcModelNotConnected: { 'zh-TW': '未連接模型', 'zh-CN': '未连接模型', en: 'No model connected', ja: '未接続のモデル', de: 'Kein Modell verbunden' },
  svcLanguageAuto: { 'zh-TW': '自動偵測', 'zh-CN': '自动检测', en: 'Auto-detect', ja: '自動検出', de: 'Automatisch erkennen' },
  svcLanguageTraditionalChinese: { 'zh-TW': '繁體中文', 'zh-CN': '繁体中文', en: 'Traditional Chinese', ja: '繁体字中国語', de: 'Traditionelles Chinesisch' },
  svcLanguageSimplifiedChinese: { 'zh-TW': '簡體中文', 'zh-CN': '简体中文', en: 'Simplified Chinese', ja: '簡体字中国語', de: 'Vereinfachtes Chinesisch' },
  svcLanguageEnglish: { 'zh-TW': '英文', 'zh-CN': '英语', en: 'English', ja: '英語', de: 'Englisch' },
  svcLanguageJapanese: { 'zh-TW': '日文', 'zh-CN': '日语', en: 'Japanese', ja: '日本語', de: 'Japanisch' },
  svcLanguageGerman: { 'zh-TW': '德文', 'zh-CN': '德语', en: 'German', ja: 'ドイツ語', de: 'Deutsch' },
  svcTranslationProfileName: { 'zh-TW': '{model}（翻譯）', 'zh-CN': '{model}（翻译）', en: '{model} (Translation)', ja: '{model}（翻訳）', de: '{model} (Übersetzung)' },
  svcHttpNoBody: { 'zh-TW': '{service} 沒有回傳資料（HTTP {status}）。請確認本機 gateway 是否已啟動。', 'zh-CN': '{service} 没有返回数据（HTTP {status}）。请确认本地 gateway 是否已启动。', en: '{service} returned no data (HTTP {status}). Check that the local gateway is running.', ja: '{service} からデータが返されませんでした（HTTP {status}）。ローカルの gateway が起動しているか確認してください。', de: '{service} hat keine Daten zurückgegeben (HTTP {status}). Prüfen Sie, ob das lokale Gateway läuft.' },
  svcHttpNonJson: { 'zh-TW': '{service} 回傳非 JSON 資料（HTTP {status}）。', 'zh-CN': '{service} 返回了非 JSON 数据（HTTP {status}）。', en: '{service} returned non-JSON data (HTTP {status}).', ja: '{service} が JSON 以外のデータを返しました（HTTP {status}）。', de: '{service} hat keine JSON-Daten zurückgegeben (HTTP {status}).' },
  svcHttpFailed: { 'zh-TW': '{service} 失敗：{error}', 'zh-CN': '{service} 失败：{error}', en: '{service} failed: {error}', ja: '{service} に失敗しました：{error}', de: '{service} fehlgeschlagen: {error}' },
  svcAudioWriteFailed: { 'zh-TW': '錄音暫存檔寫入失敗', 'zh-CN': '录音暂存文件写入失败', en: 'Failed to write the recording staging file', ja: '録音一時ファイルの書き込みに失敗しました', de: 'Aufnahme-Zwischendatei konnte nicht geschrieben werden' },
  svcOpfsRecordingClosed: { 'zh-TW': 'OPFS 錄音已關閉', 'zh-CN': 'OPFS 录音已关闭', en: 'The OPFS recording is closed', ja: 'OPFS 録音はクローズ済みです', de: 'Die OPFS-Aufnahme ist geschlossen' },
  svcCaptionPopoutBlocked: { 'zh-TW': '無法開啟字幕視窗，請允許此網站的彈出視窗。', 'zh-CN': '无法打开字幕窗口，请允许此网站的弹出窗口。', en: 'Could not open the caption window. Allow pop-ups for this site.', ja: '字幕ウィンドウを開けません。このサイトのポップアップを許可してください。', de: 'Das Untertitel-Fenster konnte nicht geöffnet werden. Erlauben Sie Pop-ups für diese Website.' },
  svcCaptionPopoutLoadTimeout: { 'zh-TW': '字幕視窗載入逾時。', 'zh-CN': '字幕窗口加载超时。', en: 'The caption window timed out while loading.', ja: '字幕ウィンドウの読み込みがタイムアウトしました。', de: 'Das Laden des Untertitelfensters hat das Zeitlimit überschritten.' },
  svcCaptionPopoutTitle: { 'zh-TW': 'S2T 即時字幕', 'zh-CN': 'S2T 实时字幕', en: 'S2T Live Captions', ja: 'S2T リアルタイム字幕', de: 'S2T Live-Untertitel' },
  svcInterruptedProcessing: { 'zh-TW': '前次背景工作在完成前中斷；逐字稿與音檔仍已保存，可重新收音或執行品質校正。', 'zh-CN': '前次后台任务在完成前中断；文字稿与音频仍已保存，可重新录音或执行质量校正。', en: 'The previous background job was interrupted before it finished. The transcript and audio are still saved; you can record again or run quality correction.', ja: '前回のバックグラウンド処理が完了前に中断されました。文字起こしと音声は保存されています。再度録音するか、品質補正を実行できます。', de: 'Der vorherige Hintergrundauftrag wurde vor Abschluss unterbrochen. Transkript und Audio sind weiterhin gespeichert; Sie können neu aufnehmen oder die Qualitätskorrektur ausführen.' },
  svcTranslationEmptyResult: { 'zh-TW': '翻譯服務回傳空白譯文，正在重新排隊。', 'zh-CN': '翻译服务返回空白译文，正在重新排队。', en: 'The translation service returned empty text; requeueing.', ja: '翻訳サービスが空の訳文を返しました。再キューしています。', de: 'Der Übersetzungsdienst hat leeren Text zurückgegeben; die Warteschlange wird neu befüllt.' },
  svcTranslationRateLimited: { 'zh-TW': '翻譯服務暫時限流，將在 {seconds} 秒後自動補翻。', 'zh-CN': '翻译服务暂时限流，将在 {seconds} 秒后自动补翻。', en: 'The translation service is rate-limiting; translation will retry automatically in {seconds}s.', ja: '翻訳サービスが一時的にレート制限中です。{seconds} 秒後に自動で再試行します。', de: 'Der Übersetzungsdienst begrenzt vorübergehend die Rate; erneuter Versuch in {seconds} s.' },
  svcTranslationFailedRetry: { 'zh-TW': '翻譯失敗，正在重新排隊。', 'zh-CN': '翻译失败，正在重新排队。', en: 'Translation failed; requeueing.', ja: '翻訳に失敗しました。再キューしています。', de: 'Übersetzung fehlgeschlagen; die Warteschlange wird neu befüllt.' },
  svcTranslationCancelled: { 'zh-TW': '已取消翻譯', 'zh-CN': '已取消翻译', en: 'Translation cancelled', ja: '翻訳をキャンセルしました', de: 'Übersetzung abgebrochen' },
  svcRemoteInvalidVersion: { 'zh-TW': '遠端沒有回傳有效的紀錄版本', 'zh-CN': '远端没有返回有效的记录版本', en: 'The remote service returned no valid record version', ja: 'リモートから有効な記録バージョンが返されませんでした', de: 'Der Remote-Dienst hat keine gültige Datensatzversion zurückgegeben' },
  svcModelConnectTimeout: { 'zh-TW': '模型連線逾時', 'zh-CN': '模型连接超时', en: 'Model connection timed out', ja: 'モデル接続がタイムアウトしました', de: 'Zeitlimit für die Modellverbindung überschritten' },
  svcModelSocketError: { 'zh-TW': '模型 WebSocket 連線發生錯誤', 'zh-CN': '模型 WebSocket 连接发生错误', en: 'The model WebSocket connection errored', ja: 'モデル WebSocket 接続でエラーが発生しました', de: 'Fehler bei der WebSocket-Verbindung zum Modell' },
  svcModelConnectFailed: { 'zh-TW': '無法連線至模型服務', 'zh-CN': '无法连接至模型服务', en: 'Could not connect to the model service', ja: 'モデルサービスに接続できません', de: 'Verbindung zum Modell-Dienst nicht möglich' },
  svcModelSocketClosed: { 'zh-TW': '模型 WebSocket 已中斷；錄音仍會繼續保存', 'zh-CN': '模型 WebSocket 已中断；录音仍会继续保存', en: 'The model WebSocket disconnected; recording keeps saving', ja: 'モデル WebSocket が切断されました。録音の保存は継続されます', de: 'Die WebSocket-Verbindung zum Modell wurde getrennt; die Aufnahme wird weiterhin gespeichert' },
  svcModelTooSlow: { 'zh-TW': '模型處理過慢，部分即時字幕音訊已略過；完整錄音仍會保存', 'zh-CN': '模型处理过慢，部分实时字幕音频已跳过；完整录音仍会保存', en: 'The model is responding slowly; some live-caption audio was skipped. The full recording is still saved.', ja: 'モデルの処理が遅く、一部のライブ字幕音声をスキップしました。完全な録音は保存されます。', de: 'Das Modell verarbeitet zu langsam; ein Teil der Live-Untertitel-Audio wurde übersprungen. Die vollständige Aufnahme wird weiterhin gespeichert.' },
  svcModelTranscribeFailed: { 'zh-TW': '模型轉錄失敗', 'zh-CN': '模型转录失败', en: 'Model transcription failed', ja: 'モデルの文字起こしに失敗しました', de: 'Transkription durch das Modell fehlgeschlagen' },
  svcAsrEndpointRequired: { 'zh-TW': '請設定轉錄 API 位址與模型名稱', 'zh-CN': '请设置转录 API 地址与模型名称', en: 'Set the transcription API endpoint and model name first.', ja: '文字起こし API のアドレスとモデル名を設定してください。', de: 'Legen Sie zuerst die API-Adresse und den Modellnamen der Transkription fest.' },
  svcModelApiKeyRequired: { 'zh-TW': '請先在設定頁儲存此模型的 API key', 'zh-CN': '请先在设置页保存此模型的 API key', en: "Save this model's API key in Settings first.", ja: '先に設定ページでこのモデルの API キーを保存してください。', de: 'Speichern Sie zuerst den API-Schlüssel dieses Modells in den Einstellungen.' },
  svcWebAsrModelOnly: { 'zh-TW': 'Web 版只能使用網站管理者設定的 ASR 模型', 'zh-CN': '网页版只能使用网站管理员设置的 ASR 模型', en: 'The web app can only use the ASR model configured by the site administrator.', ja: 'Web 版ではサイト管理者が設定した ASR モデルのみ使用できます。', de: 'Die Web-App kann nur das vom Site-Administrator konfigurierte ASR-Modell verwenden.' },
  svcSileroProvidedByGateway: { 'zh-TW': 'Silero VAD 目前由 Web gateway 的 CPU worker 提供', 'zh-CN': 'Silero VAD 目前由 Web gateway 的 CPU worker 提供', en: "Silero VAD is currently provided by the web gateway's CPU worker.", ja: 'Silero VAD は現在 Web gateway の CPU ワーカーによって提供されています。', de: 'Silero VAD wird derzeit vom CPU-Worker des Web-Gateways bereitgestellt.' },
  svcSileroGatewayFailed: { 'zh-TW': 'Silero VAD gateway 失敗（{status}）', 'zh-CN': 'Silero VAD gateway 失败（{status}）', en: 'Silero VAD gateway failed ({status})', ja: 'Silero VAD gateway が失敗しました（{status}）', de: 'Silero VAD Gateway fehlgeschlagen ({status})' },
  svcAsrRequestTimeout: { 'zh-TW': '即時 ASR 請求逾時，請確認 ASR 服務', 'zh-CN': '实时 ASR 请求超时，请检查 ASR 服务', en: 'The realtime ASR request timed out. Check the ASR service.', ja: 'リアルタイム ASR リクエストがタイムアウトしました。ASR サービスを確認してください。', de: 'Die Echtzeit-ASR-Anfrage ist abgelaufen. Prüfen Sie den ASR-Dienst.' },
  svcWavTooSmall: { 'zh-TW': 'WAV 檔案太小', 'zh-CN': 'WAV 文件太小', en: 'The WAV file is too small', ja: 'WAV ファイルが小さすぎます', de: 'Die WAV-Datei ist zu klein' },
  svcWavUnsupportedFile: { 'zh-TW': '僅支援 RIFF/WAV 檔案', 'zh-CN': '仅支持 RIFF/WAV 文件', en: 'Only RIFF/WAV files are supported', ja: 'RIFF/WAV ファイルのみサポートされます', de: 'Nur RIFF/WAV-Dateien werden unterstützt' },
  svcWavChunkIncomplete: { 'zh-TW': 'WAV chunk 資料不完整', 'zh-CN': 'WAV chunk 数据不完整', en: 'The WAV chunk data is incomplete', ja: 'WAV チャンクのデータが不完全です', de: 'Die WAV-Chunk-Daten sind unvollständig' },
  svcWavPcm16Only: { 'zh-TW': '批次切分目前只支援 PCM16 WAV', 'zh-CN': '批量切分目前只支持 PCM16 WAV', en: 'Chunked splitting currently supports PCM16 WAV only', ja: 'チャンク分割は現在 PCM16 WAV のみサポートしています', de: 'Die Abschnittsaufteilung unterstützt derzeit nur PCM16 WAV' },
  svcWavNoAudioData: { 'zh-TW': '找不到有效的 PCM16 WAV 音訊資料', 'zh-CN': '找不到有效的 PCM16 WAV 音频数据', en: 'No valid PCM16 WAV audio data found', ja: '有効な PCM16 WAV 音声データが見つかりません', de: 'Keine gültigen PCM16-WAV-Audiodaten gefunden' },
  svcGatewayUnavailable: { 'zh-TW': 'Gateway 暫時不可用（HTTP {status}）', 'zh-CN': 'Gateway 暂时不可用（HTTP {status}）', en: 'The gateway is temporarily unavailable (HTTP {status})', ja: 'Gateway は一時的に利用できません（HTTP {status}）', de: 'Das Gateway ist vorübergehend nicht verfügbar (HTTP {status})' },
  svcGatewayConnectionLost: { 'zh-TW': 'Gateway 連線中斷', 'zh-CN': 'Gateway 连接中断', en: 'Gateway connection lost', ja: 'Gateway 接続が切断されました', de: 'Gateway-Verbindung verloren' }
}
