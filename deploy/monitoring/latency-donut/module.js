System.register(['react', '@grafana/data'], function (exports) {
  var React, PanelPlugin;
  return { setters: [function (m) { React = m; }, function (m) { PanelPlugin = m.PanelPlugin; }], execute: function () {
    var stages = {
      asr_roundtrip_with_retries: ['ASR 往返', '#f2495c'], chunk_wait: ['音訊累積／切段', '#fade2a'],
      browser_queue: ['瀏覽器排隊', '#5794f2'], vad_onset: ['VAD 語音確認', '#73bf69'],
      response_to_paint: ['字幕呈現', '#b877d9'], browser_preprocess: ['音訊前處理', '#ff9830']
    };
    function value(frame) {
      var field = frame.fields.find(function (f) { return f.type === 'number'; });
      if (!field || !field.values.length) return null;
      var n = field.values.get ? field.values.get(field.values.length - 1) : field.values[field.values.length - 1];
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
    function Donut(props) {
      var h = React.createElement, series = props.data.series || [], slices = [], center = null;
      series.forEach(function (frame) {
        var n = value(frame);
        if (frame.refId === 'B') center = n;
        if (frame.refId === 'A' && n !== null && n > 0) {
          var field = frame.fields.find(function (f) { return f.type === 'number'; });
          var stage = field.labels && field.labels.stage;
          if (stages[stage]) slices.push({stage:stage, value:n});
        }
      });
      slices.sort(function (a,b) {return b.value-a.value;});
      var total = slices.reduce(function (sum,s) {return sum+s.value;},0), offset=0;
      var arcs = slices.map(function (s) {
        var percent=s.value/total*100, start=offset; offset+=percent;
        return h('circle', {key:s.stage, cx:150,cy:150,r:105,fill:'none',stroke:stages[s.stage][1],strokeWidth:36,pathLength:100,strokeDasharray:percent+' '+(100-percent),strokeDashoffset:-start,transform:'rotate(-90 150 150)'},
          h('title',null,stages[s.stage][0]+': '+percent.toFixed(2)+'%'));
      });
      var text=center===null?'—':center.toFixed(2)+' s';
      var graphic=h('svg',{viewBox:'0 0 300 300',role:'img','aria-label':(props.options.percentile||'首字延遲')+' '+text,style:{width:'100%',height:Math.max(130,props.height-95),display:'block'}},
        h('circle',{cx:150,cy:150,r:105,fill:'none',stroke:'rgba(128,128,128,.15)',strokeWidth:36}),arcs,
        h('text',{x:150,y:146,textAnchor:'middle',fill:'currentColor',fontSize:34,fontWeight:600},text),
        h('text',{x:150,y:176,textAnchor:'middle',fill:'currentColor',fontSize:14,opacity:.7},props.options.percentile||'首字延遲'));
      var legend=h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'5px 12px',fontSize:11,padding:'0 6px'}},slices.map(function(s){return h('div',{key:s.stage,style:{whiteSpace:'nowrap'}},h('span',{style:{color:stages[s.stage][1]}},'● '),stages[s.stage][0]+' '+(s.value/total*100).toFixed(2)+'%');}));
      return h('div',{style:{width:props.width,height:props.height,color:'inherit',overflow:'auto'}},graphic,total>0?legend:h('div',{style:{textAlign:'center',opacity:.7}},'所選範圍沒有首字樣本'));
    }
    exports('plugin', new PanelPlugin(Donut));
  }};
});
