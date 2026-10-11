"""Compact on-call overview; detailed panels remain in s2t-overview."""
from copy import deepcopy

def build_oncall(detail):
    panels=[]
    y=0
    def row(title):
        nonlocal y
        panels.append({'id':len(panels)+1,'title':title,'type':'row','collapsed':False,'gridPos':{'x':0,'y':y,'w':24,'h':1}})
        y+=1
    def add(title,expr,unit='short',typ='stat',x=0,width=6,height=4,legend='',description=''):
        item={'id':len(panels)+1,'title':title,'type':typ,'gridPos':{'x':x,'y':y,'w':width,'h':height},'datasource':{'type':'prometheus','uid':'s2t-prometheus'},'targets':[{'refId':'A','expr':expr,'legendFormat':legend,'instant':typ!='timeseries','range':typ=='timeseries'}],'description':description,'fieldConfig':{'defaults':{'unit':unit,'min':0,'color':{'mode':'fixed','fixedColor':'blue'}},'overrides':[]},'options':{'reduceOptions':{'calcs':['last'],'fields':'','values':False},'legend':{'displayMode':'list','placement':'bottom'},'tooltip':{'mode':'multi'}}}
        if typ=='bargauge':item['options'].update({'orientation':'horizontal','displayMode':'gradient','showUnfilled':True})
        panels.append(item)
        return item
    row('01 · 延遲｜語音到字幕（來源：$caption_gateway）')
    for index,q in enumerate([.5,.95,.99]):
        add(f'字幕 P{int(q*100)}（最近 5 分鐘）',f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{job="$caption_gateway",stage="chunk_speech_to_paint"}}[5m])) by (le))','s',x=index*8,width=8,description='完整落在即時字幕頁可見期間的 chunk 語音起點到字幕呈現；包含音訊累積與排隊，缺少樣本時顯示無資料。分位數是 histogram 估算。')
    y+=4
    chart=add('字幕延遲趨勢｜P50／P95／P99','', 's',typ='timeseries',width=16,height=5)
    chart['targets']=[{'refId':str(index),'expr':f'histogram_quantile({q}, sum(rate(s2t_caption_stage_duration_seconds_bucket{{job="$caption_gateway",stage="chunk_speech_to_paint"}}[5m])) by (le))','legendFormat':f'P{int(q*100)}','range':True,'instant':False} for index,q in enumerate([.5,.95,.99])]
    chart['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
    add('有效字幕樣本（最近 5 分鐘）','sum(increase(s2t_caption_stage_duration_seconds_count{job="$caption_gateway",stage="chunk_speech_to_paint"}[5m]))',x=16,width=8,height=5,description='無有效樣本時，延遲分位數不能用來判斷服務正常。')
    y+=5
    row('02 · 使用者｜NT 與部門（來源：$caption_gateway）')
    valid='job="$caption_gateway",nt!="",department!="",user_id!="__overflow__"'
    selected=valid+',nt=~"$usage_user",department=~"$usage_department"'
    add('有請求的 NT（最近 5 分鐘）',f'count(sum(increase(s2t_user_requests_total{{{valid}}}[5m])) by (nt) > 0)',description='最近 5 分鐘有 API 活動的使用者，非目前登入或在線人數；包含字幕遙測。')
    add('有活動的部門（最近 5 分鐘）',f'count(sum(increase(s2t_user_requests_total{{{valid}}}[5m])) by (department) > 0)',x=6)
    add('ASR 音訊量（所選範圍）',f'sum(increase(s2t_user_audio_seconds_total{{{valid},operation="transcriptions"}}[$__range])) / 3600','suffix:小時',x=12,description='成功完成的可解析 WAV 音訊量；未知格式時長不估算。')
    add('模型權杖數（所選範圍）',f'sum(increase(s2t_user_input_tokens_total{{{valid}}}[$__range])) + sum(increase(s2t_user_output_tokens_total{{{valid}}}[$__range]))',x=18,description='翻譯／摘要模型回報的輸入與輸出 token；未回報部分請查看詳細總覽。')
    y+=4
    add('使用者請求量｜前 10 位 NT（所選範圍）',f'topk(10, sum(increase(s2t_user_requests_total{{{selected}}}[$__range])) by (nt))',typ='bargauge',width=12,height=5,legend='{{nt}}',description='依選定部門與 NT 篩選，包含重試、快取命中、字幕遙測及資料 API。')
    add('部門總體請求量（所選範圍）',f'sum(increase(s2t_user_requests_total{{{valid},department=~"$usage_department"}}[$__range])) by (department)',typ='bargauge',x=12,width=12,height=5,legend='{{department}}',description='部門加總不受 NT 篩選影響。')
    y+=5
    row('03 · 請求｜入口健康與負載（來源：$caption_gateway）')
    up=add('監控入口狀態','min(up{job="$caption_gateway"})',description='Prometheus 是否能抓取此來源；可抓取不等同模型或所有下游服务正常。')
    up['fieldConfig']['defaults']['mappings']=[{'type':'value','options':{'0':{'text':'抓取失敗','color':'red'},'1':{'text':'可抓取','color':'green'}}}]
    add('API 請求速率（最近 5 分鐘）','sum(rate(s2t_gateway_request_duration_seconds_count{job="$caption_gateway"}[5m]))','reqps',x=6,description='全部 gateway API 請求，包含未登入與拒絕的請求。')
    error=add('API 錯誤率（最近 5 分鐘）','sum(rate(s2t_gateway_request_errors_total{job="$caption_gateway"}[5m])) / sum(rate(s2t_gateway_request_duration_seconds_count{job="$caption_gateway"}[5m]))','percentunit',x=12,description='4xx 與 5xx 合計；無請求時不填零。')
    error['fieldConfig']['defaults']['color']={'mode':'thresholds'}
    error['fieldConfig']['defaults']['thresholds']={'mode':'absolute','steps':[{'color':'green','value':None},{'color':'orange','value':0.000001}]}
    add('處理中的 HTTP 請求','sum(s2t_gateway_inflight_requests{job="$caption_gateway"})',x=18,description='目前請求數，包含正在執行的 metrics 抓取；不是使用者數。')
    y+=4
    for index,(title,expr,unit,legend) in enumerate([
        ('API 請求趨勢（每秒）','sum(rate(s2t_gateway_request_duration_seconds_count{job="$caption_gateway"}[5m])) by (route)','reqps','{{route}}'),
        ('已登入請求錯誤分類（每秒）',f'sum(rate(s2t_user_requests_total{{{valid},outcome!="success"}}[5m])) by (outcome)','reqps','{{outcome}}')]):
        item=add(title,expr,unit,typ='timeseries',x=index*12,width=12,height=5,legend=legend)
        item['fieldConfig']['defaults']['color']={'mode':'palette-classic'}
        names={'transcriptions':'語音辨識','translations':'翻譯','summaries':'摘要','diarizations':'講者分離','telemetry_captions':'字幕遙測','auth_session':'登入狀態','auth_register':'註冊','auth_login':'登入','auth_logout':'登出','storage':'儲存服務','audio_object':'錄音檔案','data_glossary':'詞彙表','data_voiceprints':'聲紋資料','data_diarization_jobs':'講者分離工作','data_storage_status':'儲存狀態','data_storage_audit':'儲存稽核','data_storage_retry':'儲存重試','data_model_registry':'模型設定','data_model_health':'模型健康狀態','data_model_credentials_id':'模型憑證設定','data_summary_templates':'摘要模板','audio_processing_silero_vad':'語音活動偵測','audio_processing_status':'音訊處理狀態','audio_processing_import_wav':'匯入音訊','config':'服務設定','data_sessions':'會議紀錄','data_settings':'使用者設定','other':'其他操作','client_error':'請求錯誤（4xx）','server_error':'服務錯誤（5xx）','aborted':'連線中斷'}
        for name,label in names.items():item['fieldConfig']['overrides'].append({'matcher':{'id':'byName','options':name},'properties':[{'id':'displayName','value':label}]})
    result={key:deepcopy(value) for key,value in detail.items() if key not in ('panels','uid','title')}
    result.update({'uid':'s2t-oncall','title':'S2T · 值班總覽｜延遲・使用者・請求','panels':panels,'tags':['S2T','值班'],'links':[{'title':'詳細監控與用量','type':'link','url':'/d/s2t-overview','includeVars':True,'keepTime':True,'targetBlank':True}],'description':'值班快速判讀：延遲 → NT／部門使用情況 → 請求健康。來源選擇器區分 8787 真實入口與驗收模擬資料；不將缺失資料當作零。'})
    return result
