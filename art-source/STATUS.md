# 現在の状況（2026-08-10時点）

このセッションで木のレンダリング方式を「手続き生成」から「参考画像を
下敷きにしたGemini生成アセット」へ全面的に切り替えた。今後のセッション
向けの引き継ぎメモ。

## 何が変わったか

- **幹・枝**: `app/src/scene/tree.ts`のBranch2D/bezier手続き生成を全廃。
  `art-source/trunk/winter_panel_crop.png`（参考画像の冬パネルを単独
  クロップしたもの）を下敷きにGeminiで生成した1枚画像
  (`app/public/textures/trunk/winter.png`)を、そのままカメラ向き平面
  として表示している。起動時にcanvasへデコードしてアルファチャンネル
  を解析し、①木の根元のアンカー座標（最下部の不透明行の重心x）②花房
  クラスタの配置基準（後述）を自動算出する。`createTree()`は非同期
  関数になった（画像デコードが必要なため）。
- **花房・葉クラスタ**: 春・夏・秋それぞれ3種類、
  `art-source/canopy-clusters/{spring,summer,autumn}.png`（各パネルの
  単独クロップ）を下敷きに生成。配置は「手続き骨格のtips座標」ではなく
  「幹画像のアルファチャンネルを積分画像でボックスブラーした被覆
  フィールド」から算出している（`buildAlphaCoverage`/
  `buildClusterPlacements`、`tree.ts`)。個々のクラスタは独立した
  `THREE.Mesh`+ピボットで、three.jsの通常の透明物体ソートに任せている
  （InstancedMeshで発生した「丸の山」問題を回避するため）。密度・季節
  切り替えは`setCanopySeasonState(tree, seasonId, density, scale)`。

## 生成パイプライン（再生成・追加生成する場合）

1. `/workspace/super2d/scripts/gemini_call.js`（実運用実績のあるツール、
   ユーザーの明示許可のもとで本プロジェクトのために呼び出している）を
   `GEMINI_KEY=<key> node scripts/gemini_call.js --prompt <txt> --image
   <参考画像の単独クロップ> --out <dir> --label <name> --model
   gemini-3.1-flash-image --imageSize 1K --aspectRatio 1:1` の形で叩く
2. 背景は必ず「純青(#0000FF)ソリッド、グラデーションなし」を明示的に
   プロンプトで指定する
3. `art-source/canopy-clusters/chromakey.js`でクロマキー抽出
   （キー色=青、tolerance=140, feather=60 — JPEG圧縮ノイズでこれより
   低いと背景の残留が出ることがある実測値。スピル抑制つき）
4. 512px程度にリサイズ、**パレット圧縮(`palette:true`)は使わない**
   （半透明エッジのアルファ階調を潰して縁に薄い矩形が出た実例あり）
5. `app/public/textures/canopy/`または`textures/trunk/`に配置
   （Viteの`base: '/sakura/'`があるので、コード側は
   `import.meta.env.BASE_URL`でURLを組み立てている）

**重要な教訓**: 4パネルの参考画像全体を渡して「N番目のパネルを見て」と
テキストで指示する方式は機能しなかった（実際には左半分の画風に引っ張ら
れる）。**必ず該当パネルだけを事前クロップしてから渡すこと。**

## 構図・色調の実測データ

木の画面内配置・湖の形状・空/山並みの色などが参考画像とズレている問題について、実測データと
具体的な修正方針を`art-source/COMPOSITION-REFERENCE.md`にまとめた。次にこのプロジェクトに
着手するセッションは、まずそちらを読むこと（procedural側の色・配置を勘で決めることは
`agent-workflow-policy.md` 1.5章で禁止されているため、実装前に必ず参照する）。

## 未着手（ユーザー方針「全パーツをGeminiに生成させる」のうち）

- **地面・近岸/遠岸の草**（`app/src/scene/ground.ts`）: 現状Canvas2Dの
  まだら質感テクスチャ（手続き生成）のまま
- **山並み**（`app/src/scene/mountains.ts`）: 現状Canvas2Dのグラデー
  ション+ブロッチ質感（手続き生成）のまま
- **下草（足元の草ブレード）**（`app/src/scene/vegetation.ts`）: 現状
  インスタンス化した単色ブレード（頂点カラーグラデーションのみ）
- **花畑の小花**（`app/src/scene/flowers.ts`）・**散る花びら/落ち葉**
  （`app/src/scene/sheddingParticles.ts`）: 未着手

上記も同じ「該当箇所を参考画像から単独クロップ→Gemini生成→クロマキー
抽出」のパターンを適用できる想定（地面・山並みは静止テクスチャとして
比較的簡単、下草・花畑は花房と同様のクラスタ方式が使える見込み）。

## 既知の予算/コスト

このセッションでのGemini呼び出しは合計27回（幹1回＋花房クラスタ
9枚×2ラウンド＋テスト数回）。ユーザー許可の予算「1000円まで」の
範囲内で収まっている想定（正確な課金額は未確認）。
