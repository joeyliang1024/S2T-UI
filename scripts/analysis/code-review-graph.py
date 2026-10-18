import os, json, logging
from pathlib import Path
os.environ.setdefault('CRG_DATA_DIR','/tmp/s2t-code-review-graph-complete')
os.environ['CRG_PARSE_EXECUTOR']='thread'
from code_review_graph import parser, incremental
parser.EXTENSION_TO_LANGUAGE['.cjs']='javascript'
# Thread workers share the extension map. Scope includes current untracked tests.
original_collect=incremental.collect_all_files
def collect(root,recurse_submodules=None):
    files=set(original_collect(root,recurse_submodules))
    for directory in ['src','server','tests','scripts','deploy']:
        for p in (root/directory).rglob('*'):
            if p.is_file() and not p.is_symlink() and parser.CodeParser().detect_language(p): files.add(str(p.relative_to(root)))
    return sorted(files)
incremental.collect_all_files=collect
from code_review_graph.tools.build import build_or_update_graph
from code_review_graph.tools.query import query_graph,find_large_functions,get_impact_radius,list_graph_stats
root=str(Path(__file__).resolve().parents[2])
logging.basicConfig(level=logging.INFO)
report={'tool':'code-review-graph 2.3.5','adaptations':['.cjs mapped to javascript','thread executor','include untracked source/test/scripts/deploy files'],'build':build_or_update_graph(full_rebuild=True,repo_root=root),'stats':list_graph_stats(repo_root=root),'large_functions':find_large_functions(min_lines=80,kind='Function',limit=30,repo_root=root),'queries':{},'impact':{}}
for name in ['mergeSessions','retryFailedSession','enqueueRemoteSessionSave','deleteSession','streamSummary','createAuth','saveSecret']:
    report['queries'][name]={'callers':query_graph('callers_of',name,repo_root=root),'callees':query_graph('callees_of',name,repo_root=root),'tests':query_graph('tests_for',name,repo_root=root)}
for f in ['src/renderer/src/features/sessions/domain/session-merge.ts','src/renderer/src/features/models/model-adapter.ts','server/auth/index.cjs','server/sherpa-diarization.cjs']:
    report['impact'][f]=get_impact_radius(changed_files=[f],max_depth=2,max_results=1500,repo_root=root)
out=Path(os.environ['CRG_DATA_DIR'])/'analysis-full.json'
out.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
for value in report['impact'].values():
    for key in ['changed_nodes','impacted_nodes','edges']: value.pop(key,None)
for value in report['queries'].values():
    for query in value.values(): query.pop('edges',None)
(Path(root)/os.environ.get('CRG_REPORT_PATH', 'docs/reports/CODE_REVIEW_GRAPH_CURRENT.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
print(json.dumps({'build':report['build'],'stats':report['stats'],'output':str(out)},ensure_ascii=False,default=str))
