"""Compact operational dashboard, sharing the overview's metric definitions."""
from copy import deepcopy


def build_oncall(detail):
    panels = []
    y = 0
    previous_source_y = None
    row_bottom = 0
    for source in detail['panels']:
        title = source['title']
        if not (title.startswith(('00 ·', 'E2E P90', '瓶頸段延遲', 'API 成功率',
                                  '部門 ·', '使用人數趨勢', '使用次數趨勢', 'HTTP 錯誤 ·', 'HTTP 4xx', 'HTTP 5xx', '使用漏斗', '漏斗轉換率', '04 ·'))
                or title.endswith(' healthy')):
            continue
        item = deepcopy(source)
        source_y = item['gridPos']['y']
        if previous_source_y is not None and source_y != previous_source_y:
            y = row_bottom
        item['gridPos']['y'] = y
        row_bottom = max(row_bottom, y + item['gridPos']['h'])
        previous_source_y = source_y
        panels.append(item)
    result = {key: deepcopy(value) for key, value in detail.items()
              if key not in ('panels', 'uid', 'title')}
    result.update({
        'uid': 's2t-oncall',
        'title': 'S2T · 值班總覽｜延遲・部門・健康',
        'panels': panels,
        'tags': ['S2T', '值班'],
        'links': [{'title': '詳細監控與用量', 'type': 'link', 'url': '/d/s2t-overview',
                   'includeVars': True, 'keepTime': True, 'targetBlank': True}],
        'description': 'E2E P90、t1～t7 平均、API 成功率、部門使用趨勢與漏斗、Storage 健康狀態。'
    })
    return result
