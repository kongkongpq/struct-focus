import urllib.request
import os, json

url = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json'
path = os.path.join(os.path.dirname(__file__), 'locomo10.json')
urllib.request.urlretrieve(url, path)
sz = os.path.getsize(path)
print(f'Downloaded: {sz} bytes')

# Validate
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
print(f'Conversations: {len(data)}')
c = data[0]
print(f'QA count: {len(c["qa"])}')
cats = set(q['category'] for q in c['qa'])
print(f'QA categories: {sorted(cats)}')

# Token estimate
total_chars = 0
for conv in data:
    for k, v in conv['conversation'].items():
        if k.startswith('session_') and not k.endswith('_date_time'):
            if isinstance(v, list):
                for turn in v:
                    if isinstance(turn, dict) and 'text' in turn:
                        total_chars += len(turn['text'])
print(f'Total dialog chars: {total_chars} (~{total_chars//4} tokens)')
