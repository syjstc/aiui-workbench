// Simulator-only persistence for the official Web runtime. The installed app
// keeps its original wx implementation and source files.
export function installPreviewStorage(wx,initial,send){
  const entries=new Map(initial);
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const keyOf=key=>{if(typeof key!=='string'||!key.length||key.length>1000)throw new Error('Storage key must be a nonempty string (at most 1000 characters)');return key;};
  function commit(change){
    const next=new Map(entries);
    if(change.operation==='set')next.set(change.key,clone(change.value));if(change.operation==='remove')next.delete(change.key);if(change.operation==='clear')next.clear();
    // UTF-8 bytes can exceed JS string length; the host enforces the byte cap.
    if(next.size>1000||JSON.stringify([...next]).length>1024*1024)throw new Error('Simulator storage quota exceeded');
    send(change);entries.clear();for(const [key,value] of next)entries.set(key,value);
  }
  wx.getStorageSync=key=>clone(entries.get(keyOf(key)));
  wx.setStorageSync=(key,value)=>{if(value===undefined)throw new Error('Storage requires JSON data');commit({operation:'set',key:keyOf(key),value:clone(value)});};
  wx.removeStorageSync=key=>commit({operation:'remove',key:keyOf(key)});
  wx.clearStorageSync=()=>commit({operation:'clear'});
  for(const name of ['getStorage','setStorage','removeStorage','clearStorage'])wx[name]=options=>{
    const args=options||{};
    return Promise.resolve().then(()=>{
      const value=name==='getStorage'?{data:wx.getStorageSync(args.key)}:name==='setStorage'?(wx.setStorageSync(args.key,args.data),{}):name==='removeStorage'?(wx.removeStorageSync(args.key),{}):(wx.clearStorageSync(),{});
      const result={...value,errMsg:name+':ok'};args.success?.(result);args.complete?.(result);return result;
    }).catch(error=>{const result={errMsg:name+':fail '+error.message};args.fail?.(result);args.complete?.(result);if(!args.fail)throw error;return result;});
  };
}
