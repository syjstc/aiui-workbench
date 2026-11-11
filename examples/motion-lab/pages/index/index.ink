<script def>{"navigationBarTitleText":""}</script>
<script setup>
export default {
  data: { quaternion: '0.000   0.000   0.000   1.000', taps: 0, mode: 'ready' },
  onLoad() { this.sensor = null; this.last = 0; },
  onShow() {
    this.sensor = new AbsoluteOrientationSensor({ frequency: 30 });
    this.sensor.addEventListener('reading', () => {
      if (Date.now() - this.last < 200) return;
      this.last = Date.now();
      const q = Array.from(this.sensor.quaternion);
      this.setData({ quaternion: q.map(v => v.toFixed(3)).join('   ') });
      console.info('MOTION_READING', JSON.stringify(q));
    });
    this.sensor.start();
  },
  onHide() { this.stop(); }, onUnload() { this.stop(); },
  stop() { if (this.sensor) this.sensor.stop(); this.sensor = null; },
  onKeyDown(e) { if (['Enter', 'Backspace'].includes(e.code)) e.preventDefault(); },
  onKeyUp(e) {
    if (e.code === 'Enter') { e.preventDefault(); this.setData({ taps: this.data.taps + 1, mode: 'active' }); console.info('MOTION_ACTIVE'); }
    if (e.code === 'Backspace') { e.preventDefault(); if (this.data.mode === 'active') { this.setData({ mode: 'ready' }); console.info('MOTION_READY'); } else window.close(); }
  }
};
</script>
<page><view class="root"><text class="eyebrow">WORKSHOP / 002</text><text class="title">Motion Lab</text><text class="subtitle">Move your head. Watch the numbers follow.</text><view class="readout"><text class="caption">QUATERNION · X / Y / Z / W</text><text class="values">{{quaternion}}</text></view><text class="footer">{{mode}} · {{taps}} confirmations · BACK to return</text></view></page>
<style>
.root{box-sizing:border-box;width:100%;height:100%;padding:32px 40px;display:flex;flex-direction:column;justify-content:space-between;background:#000;color:#b6ef9f;}
.eyebrow,.caption,.footer{font-size:12px;color:#82b473;}.title{font-size:44px;font-weight:700;}.subtitle{font-size:16px;}.readout{padding:22px 0;border-top:1px solid #44693a;border-bottom:1px solid #44693a;display:flex;flex-direction:column;gap:16px;}.values{font-size:23px;}
</style>
