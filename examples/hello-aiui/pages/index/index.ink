<script def>{"navigationBarTitleText":""}</script>
<script setup>
import { TempleNavigation, navigationDirection } from '../../lib/temple-navigation.js';
export default {
  data: { choice: 0, mode: 'menu', page: 0, label: 'EXPLORE' },
  onLoad() { this.nav = new TempleNavigation(); },
  onShow() { this.nav.reset(); },
  onHide() { this.nav.reset(); },
  onUnload() { this.nav.reset(); },
  onKeyDown(event) {
    if (navigationDirection(event.code)) { event.preventDefault(); this.nav.keyDown(event); }
    else if (['Enter', 'Backspace'].includes(event.code)) event.preventDefault();
  },
  onKeyUp(event) {
    if (navigationDirection(event.code)) {
      event.preventDefault();
      const direction = this.nav.keyUp(event);
      if (direction) {
        const choice = (this.data.choice + direction + 3) % 3;
        this.setData(this.data.mode === 'menu' ? { choice, label: ['EXPLORE', 'CREATE', 'CONNECT'][choice] } : { page: Math.max(0, this.data.page + direction) });
        console.info('HELLO_NAV', JSON.stringify({ choice: this.data.choice, page: this.data.page }));
      }
      return;
    }
    if (event.code === 'Enter') { event.preventDefault(); this.setData({ mode: 'pages' }); console.info('HELLO_OPEN'); }
    if (event.code === 'Backspace') {
      event.preventDefault();
      if (this.data.mode === 'pages') { this.nav.reset(); this.setData({ mode: 'menu' }); console.info('HELLO_BACK'); }
      else window.close();
    }
  }
};
</script>
<page>
  <view class="root">
    <view class="header"><text class="eyebrow">WORKSHOP / 001</text><text class="eyebrow">INK RUNTIME</text></view>
    <view class="body"><text class="title">Hello, AIUI.</text><text class="subtitle">An idea. A page. Right before your eyes.</text></view>
    <view class="selection"><text class="index">0{{choice + 1}} / 03</text><text class="label">{{label}}</text><text class="status">{{mode}} · {{page + 1}}</text></view>
    <view class="footer"><text>SWIPE TO EXPLORE</text><text>ENTER TO OPEN · BACK TO RETURN</text></view>
  </view>
</page>
<style>
.root { box-sizing:border-box; width:100%; height:100%; padding:32px 40px; display:flex; flex-direction:column; justify-content:space-between; background:#000; color:#b6ef9f; }
.header, .footer, .selection { display:flex; flex-direction:row; align-items:center; justify-content:space-between; }
.eyebrow, .footer { font-size:11px; color:#82b473; }
.body { display:flex; flex-direction:column; gap:12px; }
.title { font-size:48px; font-weight:700; }
.subtitle { font-size:15px; color:#a1cf8e; }
.selection { border-top:1px solid #44693a; border-bottom:1px solid #44693a; padding:18px 0; }
.index, .status { font-size:12px; color:#82b473; }
.label { font-size:24px; font-weight:700; }
</style>
