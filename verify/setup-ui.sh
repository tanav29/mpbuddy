#!/bin/bash
# Load the dev app with the sample clip, in Remove-sections mode.
set -e
export AGENT_BROWSER_SESSION=mpb-trim
cd /home/tnv/c/mpbuddy
agent-browser eval "localStorage.setItem('mpb-opts', JSON.stringify({trim:{mode:'remove',cuts:'',start:'',end:'0:30',exact:'off',snap:'on'}}))" >/dev/null
agent-browser reload >/dev/null
agent-browser wait 1200 >/dev/null
agent-browser eval "document.querySelector('input[type=file]').setAttribute('id','fi')" >/dev/null
agent-browser upload "#fi" /tmp/opencode/sample.mp4 >/dev/null
agent-browser wait --fn "document.body.innerText.includes('sample.mp4')" >/dev/null
agent-browser find role button click --name "Trim" >/dev/null
agent-browser wait --fn "!!document.querySelector('.trim-track')" >/dev/null
agent-browser eval "(() => { const r = document.querySelector('.trim-track').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()"
