"""Apply an external branding profile to an isolated source export."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from xml.sax.saxutils import escape


def apply_profile(profile_file: Path, root: Path):
    root=root.resolve();profile_file=profile_file.resolve()
    if any((parent/'.git').exists() for parent in [root,*root.parents]):
        raise ValueError('Use an isolated export outside every Git checkout')
    if not (root/'mobile/app.json').is_file():raise ValueError('Target is not a source export')
    data=json.loads(profile_file.read_text(encoding='utf-8'))
    name=str(data.get('displayName','')).strip()
    if not name or len(name)>80 or any(ord(ch)<32 for ch in name):raise ValueError('Invalid display name')
    defaults=json.loads((root/'mobile/src/config/branding.json').read_text(encoding='utf-8'))
    supplied=data.get('mobile',{})
    if set(supplied)-set(defaults):raise ValueError('Unknown mobile branding fields')
    mobile={**defaults,**supplied,'displayName':name}
    mobile['blackCard']={**defaults['blackCard'],**supplied.get('blackCard',{})}
    if not isinstance(mobile['blackCard']['enabled'],bool):
        raise ValueError('Card enabled must be a boolean')
    if mobile['blackCard']['enabled']:
        catalog=(root/'mobile/src/i18n/blackCardCatalog.ts').read_text(encoding='utf-8')
        keys=set(re.findall(r'"(blackCard\.marketing\.[^"]+)"',catalog))
        for locale in ['zh-CN','zh-TW','en','ja']:
            values=mobile['blackCardTranslations'].get(locale,{})
            if not keys or any(not isinstance(values.get(key),str) or not values[key].strip() for key in keys):
                raise ValueError('Enabled card requires complete content in all four languages')
    for field in ['legacyLocaleStorageKeys','legacyFavoritesStorageKeys']:
        if not isinstance(mobile[field],list) or any(not isinstance(value,str) for value in mobile[field]):
            raise ValueError('Legacy storage keys must be string arrays')
    web_keys=data.get('legacyFavoritesStorageKeys',[])
    if not isinstance(web_keys,list) or any(not isinstance(value,str) for value in web_keys):
        raise ValueError('Web legacy storage keys must be a string array')
    for notice in mobile['complianceLicenses']:
        if not isinstance(notice,dict) or any(not isinstance(notice.get(key),str) for key in ['title','subtitle']):
            raise ValueError('Invalid company notice')
    for locale,sections in data.get('webTranslations',{}).items():
        if locale not in ['zh','zh-TW','en','ja'] or not isinstance(sections,dict):
            raise ValueError('Invalid locale content')
    assets=[]
    for relative,source in data.get('assetOverrides',{}).items():
        target=(root/relative).resolve()
        if not target.is_relative_to(root/'web/public') or target.suffix.lower() not in {'.png','.jpg','.jpeg','.webp','.svg','.mp4'}:
            raise ValueError('Asset override is outside public media assets')
        asset=(profile_file.parent/source).resolve()
        if not asset.is_file():raise ValueError('Missing external media asset')
        assets.append((asset,target))
    if data.get('logoFile') and not (profile_file.parent/data['logoFile']).is_file():
        raise ValueError('Missing external logo')
    for field in ['backgroundUrl','imageUrl']:
        value=mobile['blackCard'].get(field,'')
        if value:
            url=urlparse(value)
            if url.scheme!='https' or not url.netloc or url.username or url.password:
                raise ValueError('Card media must use credential-free HTTPS URLs')
    (root/'mobile/src/config/branding.json').write_text(json.dumps(mobile,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    web={'displayName':name,'organization':str(data.get('organization','')),'supportEmail':str(data.get('supportEmail','')),'legacyFavoritesStorageKeys':data.get('legacyFavoritesStorageKeys',[])}
    (root/'web/config/branding.json').write_text(json.dumps(web,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    app_path=root/'mobile/app.json';app=json.loads(app_path.read_text(encoding='utf-8'));app['displayName']=name
    app_path.write_text(json.dumps(app,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    strings=root/'mobile/android/app/src/main/res/values/strings.xml'
    strings.write_text('<resources>\n    <string name="app_name">'+escape(name).replace("'","\\'")+'</string>\n</resources>\n',encoding='utf-8')
    for filename in ['Info.plist','Info-Debug.plist']:
        path=root/'mobile/ios/ExchangeMobile'/filename
        value=re.sub(r'(<key>CFBundleDisplayName</key>\s*<string>).*?(</string>)',lambda m:m[1]+escape(name)+m[2],path.read_text(encoding='utf-8'))
        path.write_text(value,encoding='utf-8')
    storyboard=root/'mobile/ios/ExchangeMobile/LaunchScreen.storyboard'
    contents=storyboard.read_text(encoding='utf-8')
    contents=re.sub(r'<label\b[^>]*\bid="GJd-Yh-RWb"[^>]*>',lambda m:re.sub(r'text="[^"]*"',lambda _: 'text="'+escape(name,{'"':'&quot;'})+'"',m[0]),contents)
    storyboard.write_text(contents,encoding='utf-8')
    for locale,sections in data.get('webTranslations',{}).items():
        if locale not in ['zh','zh-TW','en','ja']:raise ValueError('Unsupported locale')
        path=root/f'web/config/locales/{locale}.json';catalog=json.loads(path.read_text(encoding='utf-8'))
        catalog.update(sections);path.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    for asset,target in assets:
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(asset,target)
    command=[sys.executable,str(root/'mobile/scripts/generate_brand_app_icons.py'),'--root',str(root),'--background',data.get('iconBackground','#1E293B')]
    if data.get('logoFile'):command += ['--logo',str(profile_file.parent/data['logoFile'])]
    subprocess.run(command,check=True)
    manifest_file=root/'SOURCE_MANIFEST.json'
    if manifest_file.exists():
        manifest=json.loads(manifest_file.read_text(encoding='utf-8'))
        for _,target in assets:
            manifest[target.relative_to(root).as_posix()]=''
        for relative in ['mobile/src/assets/brand','mobile/android/app/src/main/res',
                         'mobile/ios/ExchangeMobile/Images.xcassets','web/public/icons']:
            for path in (root/relative).rglob('*'):
                if path.is_file():manifest[path.relative_to(root).as_posix()]=''
        for relative in manifest:
            path=(root/relative).resolve()
            if not path.is_relative_to(root):raise ValueError('Invalid source manifest path')
            manifest[relative]=hashlib.sha256(path.read_bytes()).hexdigest()
        manifest_file.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return {'displayName':name,'target':str(root)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',type=Path,required=True);parser.add_argument('--target',type=Path,required=True)
    args=parser.parse_args();print(json.dumps(apply_profile(args.profile,args.target),ensure_ascii=False))
