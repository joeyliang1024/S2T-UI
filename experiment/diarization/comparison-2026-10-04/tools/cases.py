from pathlib import Path
import json
root=Path(__file__).resolve().parents[2];out=root/'outputs/diarization';d=json.loads((out/'final-comparison.json').read_text());cases=[]
for id,data in d['datasets'].items():
 if data.get('synthetic'):continue
 methods=data['methods'];base=methods.get('sherpa-0.8');cand=methods.get('nemotron-v3-offline-pad005') or methods.get('nemotron-v3-offline')
 if not base or not cand:continue
 def active(method,t):return [x['speaker'] for x in method['turns'] if x['start']<=t<x['end']]
 for region,lo,hi in [('開頭',0,min(60,data['duration'])),('中段',data['duration']/2-30,data['duration']/2+30),('尾段',data['duration']-60,data['duration'])]:
  candidates=[]
  for n in range(int(lo*5),int(hi*5)):
   t=n/5;truth=[x['speaker'] for x in data['truth'] if x['start']<=t<x['end']];a=active(base,t);b=active(cand,t);alignedA=[base['metrics']['mapping'].get(x,'unmatched') for x in a];alignedB=[cand['metrics']['mapping'].get(x,'unmatched') for x in b]
   if truth and set(alignedA)!=set(truth) and set(alignedB)==set(truth):candidates.append((t,truth,a,b,alignedA,alignedB))
  if candidates:
   t,truth,a,b,alignedA,alignedB=candidates[len(candidates)//2];cases.append({'id':id,'region':region,'seconds':t,'clipStart':max(0,t-5),'clipEnd':min(data['duration'],t+5),'referenceActive':truth,'baselineRaw':a,'candidateRaw':b,'baselineReferenceAlignment':alignedA,'candidateReferenceAlignment':alignedB,'candidateMethod':next(name for name,value in methods.items() if value is cand),'humanListened':False})
 # preserve candidate regressions, even if the aggregate DER improved
 for n in range(int(data['duration']*5)):
  t=n/5;truth=[x['speaker'] for x in data['truth'] if x['start']<=t<x['end']];a=active(base,t);b=active(cand,t);aa=[base['metrics']['mapping'].get(x,'unmatched') for x in a];bb=[cand['metrics']['mapping'].get(x,'unmatched') for x in b]
  if truth and set(aa)==set(truth) and set(bb)!=set(truth):
   cases.append({'id':id,'region':'候選退步反例','seconds':t,'clipStart':max(0,t-5),'clipEnd':min(data['duration'],t+5),'referenceActive':truth,'baselineRaw':a,'candidateRaw':b,'baselineReferenceAlignment':aa,'candidateReferenceAlignment':bb,'humanListened':False});break
(out/'error-cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2))
lines=['# 講者標註核對案例','','以下依 RTTM 與模型分歧自動選取，尚未人工聽音。本輪 DER 使用資料集標註評分，不把這份案例文字稱為另建的人工答案。回放頁選對應音檔並跳到秒數，即可聽音核對；最佳標籤映射僅用於評分，不是模型知道真實姓名。','']
for c in cases:
 lines += [f"## {c['id']}／{c['region']}／{c['seconds']:.1f} 秒",'',f"聽音建議：{c['clipStart']:.1f}–{c['clipEnd']:.1f} 秒。",'',f"- 參考正在發聲：{', '.join(c['referenceActive'])}",f"- 現況原始標籤：{', '.join(c['baselineRaw']) or '無'}；對齊參考：{', '.join(c['baselineReferenceAlignment']) or '無'}",f"- 候選原始標籤：{', '.join(c['candidateRaw']) or '無'}；對齊參考：{', '.join(c['candidateReferenceAlignment']) or '無'}",'']
(out/'核對案例.md').write_text('\n'.join(lines));print('Saved',len(cases),'case windows')

with (out/'核對案例.md').open('a') as f:
 f.write('\n## hkzpa／多出身份的尾段反例\n\n954.8–964.7 秒：Nemotron 預設離線配置多出的第三標籤累計約 9.86 秒，資料集參考只有兩人。尚未人工聽音；回放跳到 955 秒核對，不能直接刪除或改成某人。Silero 過濾也未消除它。\n')
