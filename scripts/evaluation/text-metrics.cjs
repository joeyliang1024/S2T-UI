// CER／WER 共用指標。評測腳本與事後比較腳本（compare-reports）共用，
// 保證兩邊算法一致。
//
// WER 用 Node 內建的 Intl.Segmenter（ICU 字典分詞）切 zh-TW 詞邊界——
// 不引入 nodejieba／segmentit 等原生依賴；先經 normalize 去標點空白，
// 分詞結果即為 word-like 片段。中文 WER 的词界品質接近 jieba 類字典法，
// 對「同一素材跨 preset 對比」這種相對比較已足夠穩定。
const segmenter = new Intl.Segmenter('zh-TW', { granularity: 'word' })

const normalize = (text) => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

const words = (text) => [...segmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment)

// 詞/字元序列的編輯距離（陣列版，字元串與詞陣列通用）。
const editDistance = (left, right) => {
  let previous = new Uint32Array(right.length + 1)
  for (let index = 0; index <= right.length; index += 1) previous[index] = index
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint32Array(right.length + 1)
    current[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[right.length]
}

// 語料級：整曲標準答案 vs 整曲字幕，字元（CER）與詞（WER）各算一次。
const corpusRates = (referenceText, hypothesisText) => {
  const reference = normalize(referenceText)
  const hypothesis = normalize(hypothesisText)
  const referenceWords = words(reference)
  const hypothesisWords = words(hypothesis)
  return {
    cer: reference.length ? editDistance([...reference], [...hypothesis]) / reference.length : null,
    refChars: reference.length,
    cerDistance: reference.length ? editDistance([...reference], [...hypothesis]) : 0,
    wer: referenceWords.length ? editDistance(referenceWords, hypothesisWords) / referenceWords.length : null,
    refWords: referenceWords.length,
    werDistance: referenceWords.length ? editDistance(referenceWords, hypothesisWords) : 0
  }
}

// 逐句級：同上但以單句為單位。
const sentenceRates = (referenceText, hypothesisText) => {
  const reference = normalize(referenceText)
  const hypothesis = normalize(hypothesisText)
  const referenceWords = words(reference)
  return {
    cer: reference.length ? editDistance([...reference], [...hypothesis]) / reference.length : null,
    refChars: reference.length,
    wer: referenceWords.length ? editDistance(referenceWords, words(hypothesis)) / referenceWords.length : null,
    refWords: referenceWords.length
  }
}

module.exports = { normalize, words, editDistance, corpusRates, sentenceRates }
