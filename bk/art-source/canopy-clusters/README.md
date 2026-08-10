# 花房・葉クラスタ生成アセットの来歴

`app/public/textures/canopy/`で使っている花房/葉クラスタ画像（春・夏・秋 各3種）の生成元。

- 生成: Gemini (`gemini-3.1-flash-image`)、`/home/user/sakura/1786259704552.png`（参考画像）を
  入力にした image-to-image。プロンプトは`prompts/`。
- 背景は純青(#0000FF)のクロマキー用ソリッドで生成させ、`chromakey.js`（クロマキー抽出＋
  スピル抑制）でアルファ付きPNGに変換。ツール本体は`/workspace/super2d/scripts/gemini_call.js`
  （そのプロジェクトの実運用実績があるツールを、ユーザーの明示許可のもとで本プロジェクトの
  ために呼び出したもの）。
- `raw/`は生の生成結果（APIレスポンスJSON全体・デコード済み画像）を一切加工せず保存したもの。
  `app/public/textures/canopy/`にあるのは512x512にリサイズ・パレット圧縮した配信用版。

再生成する場合は`chromakey.js`をそのまま使い、`GEMINI_KEY`環境変数にAPIキーを渡して
`prompts/*.txt`を`--prompt`に渡す。
