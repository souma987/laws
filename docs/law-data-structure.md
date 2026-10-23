# 法令本文APIの構造と画面での扱い

この文書は、e-Gov 法令API v2 の法令本文取得APIを、民法の実レスポンスとAPI仕様書の例に照らして整理したもの。特に、目次と本文は別のノード群であること、条・項・号の番号は異なるフィールドに入ることを記録する。

## 1. 取得APIとレスポンス形式

使用するAPIは `GET /api/2/law_data/{law_id_or_num_or_revision_id}`。パスには法令ID、法令番号、または法令履歴IDを指定する。法令ID・法令番号では最新履歴が返り、履歴IDなら指定履歴が返る。`asof`を指定すると、その時点で有効な履歴を取得する。

このサイトは次のパラメータを付けている。

| パラメータ | 値 | 意味 |
|---|---|---|
| `response_format` | `json` | 外側のレスポンス形式 |
| `law_full_text_format` | `json` | `law_full_text`の形式 |
| `json_format` | `full` | 法令XMLの階層と属性を保つ詳細JSON |

`json_format=full`はAPIの既定値だが、画面処理がこの形式に依存するため明示している。`light`は要素名をプロパティ名にし、繰返し要素を配列にする別形式で、属性情報の持ち方も詳細JSONと異なる。このサイトは`light`を処理しない。

`elm`を指定すると、`law_full_text`は全文ルートの`Law`ではなく、指定した要素（例：`Article`、`TOC`）自体がルートになる。このサイトは`elm`を送らず全文を取得するが、`law_full_text`のルートが常に`Law`だと決めつけてはならない。

## 2. 外側のレスポンス

レスポンスの各項目は役割が異なる。

| キー | 内容 | この画面での利用 |
|---|---|---|
| `law_info` | 法令ID、法令番号、公布日など、改正履歴に依存しない情報 | 法令番号表示 |
| `revision_info` | 法令名、改正履歴ID、基準日、改正情報など | ページタイトル |
| `attached_files_info` | 画像など添付ファイル情報。ない場合は`null` | 現在は描画しない |
| `law_full_text` | 法令本文の構造データ | 本文の描画元 |

民法の取得では、例として`revision_info.law_revision_id`が`129AC0000000089_20260624_508AC0000000045`、`revision_info.law_title`が`民法`として返った。改正や時点によってこの値は変わる。

## 3. 詳細JSONの基本単位

詳細JSONはXMLの要素順・親子関係を保つ。要素ノードの基本形は以下。

```json
{
  "tag": "Sentence",
  "attr": { "Num": "1", "WritingMode": "vertical" },
  "children": ["本文の文字列"]
}
```

- `tag`: XML要素名。
- `attr`: XML属性。番号や表示方向などを含む。属性がない要素では空オブジェクトになる。
- `children`: 子要素と文字列の順序付き配列。文字列だけの子もあり、子要素が複数なら複数のオブジェクトが並ぶ。

子要素をタグ名で連想配列化したり、文字列をすべて同じ種類の本文として扱ったりすると、法令の順序・階層・番号の意味を失う。

## 4. 全文ルートと法令全体の階層

全文取得時の民法レスポンスは、概ね次の順序だった。法令ごとに任意要素や繰返し数は異なる。

```text
レスポンス
├─ law_info
├─ revision_info
├─ attached_files_info
└─ law_full_text
   └─ Law (attr: 法令種別、元号、年、法令番号など)
      ├─ LawNum
      └─ LawBody
         ├─ LawTitle
         ├─ EnactStatement (民法では複数)
         ├─ TOC (目次)
         ├─ MainProvision (本則)
         ├─ SupplProvision (附則。民法では多数)
         └─ Appdx* (別表・別記等。法令により存在)
```

民法の`LawBody`には複数の`EnactStatement`と、1個の`TOC`、1個の`MainProvision`があり、その後に多数の`SupplProvision`が並んでいた。したがって、`SupplProvision`を単一要素とみなしたり、`LawBody`直下を固定個数と仮定したりできない。`SupplProvision`には`AmendLawNum`や`Extract`などの属性があり、それぞれの改正附則・抄録に対応する。

本則の主要な階層は次のとおり。編・章・節・款・目は存在する階層だけが現れる。

```text
MainProvision
└─ Part? → Chapter? → Section? → Subsection? → Division?
   └─ Article (条)
      ├─ ArticleCaption? (条の括弧書き)
      ├─ ArticleTitle (法令上の条表記)
      ├─ Paragraph (項)
      └─ Item (号。該当条ではParagraphと並ぶ兄弟要素)
         └─ Subitem1 → Subitem2 → … (号の細分)
```

これは固定位置の配列ではなく、`tag`で識別する順序付きツリーである。例えば民法第424条の2では、`Article`の`children`に`Paragraph`が一つあり、その後に三つの`Item`が続く。号はその例では`Paragraph`の子ではなく`Article`の子である。別の構造でも、各`Item`を親の子要素として順序通り処理する。

## 5. 目次（TOC）の構造

目次は`LawBody`内の`TOC`ノードで、本則の`MainProvision`とは別。本文条文そのものではなく、編・章・節・款などの見出しと、その範囲を示す`ArticleRange`を含む。

民法の実レスポンスは次の形だった。

```text
TOC
├─ TOCLabel: "目次"
└─ TOCPart (attr.Num: "1")
   ├─ PartTitle: "第一編　総則"
   ├─ TOCChapter (attr.Num: "1")
   │  ├─ ChapterTitle: "第一章　通則"
   │  └─ ArticleRange: "（第一条・第二条）"
   └─ TOCChapter (attr.Num: "2")
      ├─ ChapterTitle: "第二章　人"
      ├─ TOCSection (attr.Num: "1")
      │  ├─ SectionTitle: "第一節　権利能力"
      │  └─ ArticleRange: "（第三条）"
      └─ TOCSection (attr.Num: "2")
         ├─ SectionTitle: "第二節　意思能力"
         └─ ArticleRange: "（第三条の二）"
```

さらに深い階層では`TOCSubsection`（款）が`TOCSection`の下に入る。編や節がない法令では対応するTOCノードもない。`ArticleRange`は条文範囲を示す文字列であり、個別の`Article`ノードでもリンク先IDでもない。

APIで目次だけを見るリクエストは`elm=TOC`。このときの`law_full_text`は`{"tag":"TOC", ...}`で始まり、`Law`ルートではない。目次の実データでは、見出し名は`TOCPart`等ではなく、その子の`PartTitle`、`ChapterTitle`、`SectionTitle`、`SubsectionTitle`に入る。

画面のナビゲーションはこの`TOC`ノードを使わず、法令本文の`MainProvision`内にある`Part`、`Chapter`、`Section`、`Subsection`、`Division`の構造から構築する。これによりAPIに独立した`TOC`がない法令でも、本文側に階層見出しがあれば目次を作れる。

画面では`ArticleRange`の漢数字表記を算用数字にし、範囲を見出しの横に置く。例えば`（第一条・第二条）`は`1–2条`、`（第九十三条―第九十八条の二）`は`93–98条の2`、`（第百六十三条の二―第百六十三条の五）`は`163条の2–5`と表示する。同一条の枝番号範囲では条番号を重複させない。

本文中で複数の条をまとめた`Article`は、`attr.Num`に`170:174`のような機械用の範囲を持ち、`ArticleTitle`には「第百七十条から第百七十四条まで」のような法令上の表記が入る。コロンを条番号としてそのまま表示せず、`ArticleTitle`を意味上の表記として使って漢数字を算用数字に変換する。したがって民法の例は見出しが「第170条から第174条まで」、本文が「削除」となる。`ArticleTitle`が「及び」を使う場合も同様に、その意味を保持する。

## 6. 条・項・号の番号と本文

### 条

民法第424条の2を`elm=MainProvision-Article_424_2`で取得した実レスポンスでは、該当要素自体が`law_full_text`ルートだった。

```json
{
  "tag": "Article",
  "attr": { "Num": "424_2" },
  "children": [
    { "tag": "ArticleCaption", "attr": {}, "children": ["（相当の対価を得てした財産の処分行為の特則）"] },
    { "tag": "ArticleTitle", "attr": {}, "children": ["第四百二十四条の二"] },
    { "tag": "Paragraph", "attr": { "Num": "1" }, "children": ["…"] },
    { "tag": "Item", "attr": { "Num": "1" }, "children": ["…"] },
    { "tag": "Item", "attr": { "Num": "2" }, "children": ["…"] },
    { "tag": "Item", "attr": { "Num": "3" }, "children": ["…"] }
  ]
}
```

`Article.attr.Num`は`"424_2"`。アンダースコアは条番号の枝番号区切りで、画面表記にすると`第424条の2`。`ArticleTitle`は`第四百二十四条の二`という元の表示文字列であり、別の値である。`ArticleCaption`はその条の括弧書き。今の画面はAPIの`Num`を使って太字の`第424条の2`とし、キャプションを同じ行に続ける。

`Article.attr.Num`を単純に`第${Num}条`へ埋め込むと`第424_2条`になり誤り。`ArticleTitle`を見出し文字列として使う場合は、算用数字表記への変換はAPIが行っていない。

### 項

`Paragraph.attr.Num`は機械処理用の項番号。`ParagraphNum`は法令上表示する番号の要素。民法第424条の2の第1項では`attr.Num`が`"1"`である一方、`ParagraphNum.children`は空で、条文上も第1項の番号は表示されない。第2項以降は`ParagraphNum`に`２`等があるため番号が表示される。画面は、`ParagraphNum`が空でないことを確認してから`Paragraph.attr.Num`を番号に使う。

憲法第4条では`Paragraph`が2つあり、`attr.Num`は`"1"`と`"2"`、どちらも`ParagraphNum.children`は空で、2つ目には`attr.OldNum: "true"`がある。それぞれの`ParagraphSentence`に`Sentence`が1つずつ入る。画面ではこのAPIパターンの番号を`①`、`②`として段落の先頭に表示し、各段落の間隔は通常どおりにする。

項本文は`ParagraphSentence`の下の一つ以上の`Sentence`にある。`Sentence.attr.Num`は文の番号であり、項番号ではない。`WritingMode`など表示属性も付く。`Ruby`/`Rt`など文中に現れる要素は段落本文内のインライン構造として扱う。

### 号と号細分

号は`Item`。`Item.attr.Num`は`"1"`等の機械処理用番号、`ItemTitle`は`一`等の法令上の表示ラベル、`ItemSentence`以下の`Sentence`が本文を持つ。号細分は`Subitem1`、`Subitem2`等で表され、それぞれの`SubitemNTitle`と`SubitemNSentence`を持つ。

ただし、`ItemSentence`等の号本文要素の子が直接`Sentence`とは限らない。民法602条では`ItemSentence`の下に`Column`が2つあり、第1列が賃貸借の種類、第2列が期間を示す。民法465条の6では、号の下の`Subitem1Sentence`にも同じ列構造があり、第2列に長い本文が入る。列を保ったグリッドで表示し、長い列は折り返せる幅に制限する。末尾の列が短い値の場合だけ右寄せする。

民法第424条の2では、項本文に「次に掲げる要件」とあり、同じ`Article.children`の後続要素に`Item`が三つ並ぶ。したがって、項本文と号本文をひとつの文に連結せず、`Paragraph`と各`Item`を別ブロックに置く。親要素の中にある番号要素と本文要素を、同じ横並びの行に配置する。

## 7. 附則・別表・その他の本文要素

- `SupplProvision`: 附則。法令本文には複数現れることがある。`SupplProvisionLabel`、`SupplProvisionTitle`、`Paragraph`等を子に持つ。
- `AppdxTable`: 別表。`AppdxTableTitle`や表構造を含み得る。
- `AppdxStyle`、`AppdxFormat`、`AppdxNote`、`AppdxFig`等: 別記様式、書式、注、図など。実際に含まれる要素は法令により異なる。
- `TableStruct`、`Table`、`TableRow`、`TableColumn`: 表の階層。
- `Fig`、`FigStruct`: 図および画像参照。画像本体は本文JSONと別の添付ファイル情報で取得する場合がある。

法令API仕様書の`elm`一覧にも、`EnactStatement`、`TOC`、`Preamble`、`MainProvision`、`Part`、`Chapter`、`Section`、`Subsection`、`Division`、`Article`、`Paragraph`、`Item`、`Subitem1`、`SupplProvision`、`AppdxTable`、`AppdxStyle`、`AppdxFormat`等が例示されている。ここにないタグも含め、すべての法令に同一の子要素があるとは限らない。

## 8. 簡易JSONとの違い

簡易JSONは詳細JSONと同じオブジェクト形ではない。例えば詳細JSONの条は`tag`/`attr`/`children`で表されるが、簡易JSONでは概ね次のようにキーがタグ名になる。繰返し要素は配列、単一要素は値またはオブジェクトとして返る。

```json
{
  "Article": {
    "ArticleTitle": "第一条",
    "Paragraph": [
      { "ParagraphNum": null, "ParagraphSentence": { "Sentence": "第1項本文" } },
      { "ParagraphNum": "２", "ParagraphSentence": { "Sentence": "第2項本文" } }
    ]
  }
}
```

簡易JSONの例は形を示すために省略した例で、常に`Paragraph`が配列になるという意味ではない。項目の有無や単一／複数によって形が変わる。詳細JSON用のパーサーを簡易JSONにそのまま適用してはならない。

## 9. このサイトの実装範囲

画面は詳細JSONを再帰的に読み、`Article`、`Paragraph`、`Item`、`Subitem`を専用処理する。条番号は`Article.attr.Num`の枝番号を`第424条の2`形式にしてキャプションと同じ行に表示し、同じ値から`a424-2`のような条文IDを付ける。したがって、例えば`?law_id=129AC0000000089#a424-2`で民法第424条の2へ直接移動できる。項番号は`ParagraphNum`が空でないときだけ表示する。連続する号は`ItemTitle`をラベル、`ItemSentence`を本文として個々に配置し、それらをまとめて一つの枠で囲む。その他の構造は子要素の順序を保って汎用表示する。

画面は`MainProvision`の構造見出しを本文欄から分離し、画面幅が十分ある場合は左パネルに表示する。`Part`、`Chapter`等の階層を展開せず、同じ階層のフラットな一覧にする。各項目は本文の同じ構造ノードへ、短い規則的なアンカーでリンクする。例えば第2編第12章は`#p2-c12`、第3節まで含む場合は`#p2-c12-s3`となる。編・章・節等の番号と名称は別の列にし、名称が折り返した行も名称列の左端に揃える。条文範囲は子孫の`Article.attr.Num`の先頭と末尾から算用数字で組み立て、見出しの横に表示する。目次には条ごとの項目を作らない。狭い画面では目次を本文の上に移す。

`law_info`と現在表示中の`revision_info`のメタデータは、本文右側の法令情報パネルに表示する。法令IDと改正履歴IDは外部リンクマークを付け、対応するe-Gov法令検索ページへリンクする。過去を含む改正履歴は別API `GET /law_revisions/{law_id_or_num}`から新しい順に取得し、下の独立パネルにリスト表示する。履歴リストだけを独立してスクロールでき、各履歴は履歴IDへのリンクで、選択するとその改正時点の本文を開く。`current_revision_status`が`CurrentEnforced`の項目には太字の日付と「施行中」を表示する。表示中の`revision_info.law_revision_id`と一致する項目は枠で囲み、施行中でもある場合は状態表示を「施行中」のみにする。中間幅では目次を上部へ移して本文とパネルを並べ、狭い画面では各パネルを本文の前後に積む。

この実装はe-Govの公式HTMLレイアウトを再現するものではなく、すべての別表・図・複雑な表を専用レイアウトで再現するものでもない。APIの`TOC`は本文JSONに含まれる場合も、目次だけを取得する`elm=TOC`のルートになる場合もあるが、この画面のナビゲーション生成には使わない。

## 10. 参照元

- [法令API v2 仕様書（この作業領域のコピー）](lawapi-v2.yaml): `/law_data/{law_id_or_num_or_revision_id}`、`json_format`、`elm`、`example_law_data_json`、`example_law_data_json2`。
- [民法第424条の2の実レスポンス](https://laws.e-gov.go.jp/api/2/law_data/129AC0000000089?response_format=json&law_full_text_format=json&json_format=full&elm=MainProvision-Article_424_2)。
- [民法の目次レスポンス](https://laws.e-gov.go.jp/api/2/law_data/129AC0000000089?response_format=json&law_full_text_format=json&json_format=full&elm=TOC)。
- [法令データ ドキュメンテーション](https://laws.e-gov.go.jp/docs/)。
