var B,f,pe,ze,E,se,fe,he,J,F,D,de,G,K,Y,$e,$={},W=[],We=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,O=Array.isArray;function C(t,e){for(var n in e)t[n]=e[n];return t}function Q(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function Le(t,e,n){var i,_,o,s={};for(o in e)o=="key"?i=e[o]:o=="ref"?_=e[o]:s[o]=e[o];if(arguments.length>2&&(s.children=arguments.length>3?B.call(arguments,2):n),typeof t=="function"&&t.defaultProps!=null)for(o in t.defaultProps)s[o]===void 0&&(s[o]=t.defaultProps[o]);return R(t,s,i,_,null)}function R(t,e,n,i,_){var o={type:t,props:e,key:n,ref:i,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:_??++pe,__i:-1,__u:0};return _==null&&f.vnode!=null&&f.vnode(o),o}function A(t){return t.children}function z(t,e){this.props=t,this.context=e}function P(t,e){if(e==null)return t.__?P(t.__,t.__i+1):null;for(var n;e<t.__k.length;e++)if((n=t.__k[e])!=null&&n.__e!=null)return n.__e;return typeof t.type=="function"?P(t):null}function Be(t){if(t.__P&&t.__d){var e=t.__v,n=e.__e,i=[],_=[],o=C({},e);o.__v=e.__v+1,f.vnode&&f.vnode(o),X(t.__P,o,e,t.__n,t.__P.namespaceURI,32&e.__u?[n]:null,i,n??P(e),!!(32&e.__u),_),o.__v=e.__v,o.__.__k[o.__i]=o,ye(i,o,_),e.__e=e.__=null,o.__e!=n&&me(o)}}function me(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),me(t)}function le(t){(!t.__d&&(t.__d=!0)&&E.push(t)&&!L.__r++||se!=f.debounceRendering)&&((se=f.debounceRendering)||fe)(L)}function L(){try{for(var t,e=1;E.length;)E.length>e&&E.sort(he),t=E.shift(),e=E.length,Be(t)}finally{E.length=L.__r=0}}function be(t,e,n,i,_,o,s,l,u,a,p){var d,r,c,m,k,x,y=i&&i.__k||W,h=e.length;for(u=Oe(n,e,y,u,h),d=0;d<h;d++)(c=n.__k[d])!=null&&(r=c.__i!=-1&&y[c.__i]||$,c.__i=d,x=X(t,c,r,_,o,s,l,u,a,p),m=c.__e,c.ref&&r.ref!=c.ref&&(r.ref&&Z(r.ref,null,c),p.push(c.ref,c.__c||m,c)),k==null&&m!=null&&(k=m),4&c.__u?(u=ve(c,u,t),r.__e&&(r.__e=null)):typeof c.type=="function"&&x!==void 0?u=x:m&&(u=m.nextSibling),c.__u&=-7);return n.__e=k,u}function Oe(t,e,n,i,_){var o,s,l,u,a,p=n.length,d=p,r=0;for(t.__k=new Array(_),o=0;o<_;o++)(s=e[o])!=null&&typeof s!="boolean"&&typeof s!="function"?(typeof s=="string"||typeof s=="number"||typeof s=="bigint"||s.constructor==String?s=t.__k[o]=R(null,s,null,null,null):O(s)?s=t.__k[o]=R(A,{children:s},null,null,null):s.constructor===void 0&&s.__b>0?s=t.__k[o]=R(s.type,s.props,s.key,s.ref?s.ref:null,s.__v):t.__k[o]=s,u=o+r,s.__=t,s.__b=t.__b+1,l=null,(a=s.__i=Ve(s,n,u,d))!=-1&&(d--,(l=n[a])&&(l.__u|=2)),l==null||l.__v==null?(a==-1&&(_>p?r--:_<p&&r++),typeof s.type!="function"&&(s.__u|=4)):a!=u&&(a==u-1?r--:a==u+1?r++:(a>u?r--:r++,s.__u|=4))):t.__k[o]=null;if(d)for(o=0;o<p;o++)(l=n[o])!=null&&(2&l.__u)==0&&(l.__e==i&&(i=P(l)),ke(l,l));return i}function ve(t,e,n){var i,_;if(typeof t.type=="function"){for(i=t.__k,_=0;i&&_<i.length;_++)i[_]&&(i[_].__=t,e=ve(i[_],e,n));return e}t.__e!=e&&(e&&t.type&&!e.parentNode&&(e=P(t)),e=n.insertBefore(t.__e,e||null));do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function Ve(t,e,n,i){var _,o,s,l=t.key,u=t.type,a=e[n],p=a!=null&&(2&a.__u)==0;if(a===null&&l==null||p&&l==a.key&&u==a.type)return n;if(i>(p?1:0)){for(_=n-1,o=n+1;_>=0||o<e.length;)if((a=e[s=_>=0?_--:o++])!=null&&(2&a.__u)==0&&l==a.key&&u==a.type)return s}return-1}function ce(t,e,n){e[0]=="-"?t.setProperty(e,n??""):t[e]=n==null?"":typeof n!="number"||We.test(e)?n:n+"px"}function j(t,e,n,i,_){var o,s;e:if(e=="style")if(typeof n=="string")t.style.cssText=n;else{if(typeof i=="string"&&(t.style.cssText=i=""),i)for(e in i)n&&e in n||ce(t.style,e,"");if(n)for(e in n)i&&n[e]==i[e]||ce(t.style,e,n[e])}else if(e[0]=="o"&&e[1]=="n")o=e!=(e=e.replace(de,"$1")),s=e.toLowerCase(),e=s in t||e=="onFocusOut"||e=="onFocusIn"?s.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+o]=n,n?i?n[D]=i[D]:(n[D]=G,t.addEventListener(e,o?Y:K,o)):t.removeEventListener(e,o?Y:K,o);else{if(_=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&n==1?"":n))}}function ue(t){return function(e){if(this.l){var n=this.l[e.type+t];if(e[F]==null)e[F]=G++;else if(e[F]<n[D])return;return n(f.event?f.event(e):e)}}}function X(t,e,n,i,_,o,s,l,u,a){var p,d,r,c,m,k,x,y,h,w,M,H,U,ae,N,q,S=e.type;if(e.constructor!==void 0)return null;128&n.__u&&(u=!!(32&n.__u),o=[l=e.__e=n.__e]),(p=f.__b)&&p(e);e:if(typeof S=="function"){d=s.length;try{if(h=e.props,w=S.prototype&&S.prototype.render,M=(p=S.contextType)&&i[p.__c],H=p?M?M.props.value:p.__:i,n.__c?y=(r=e.__c=n.__c).__=r.__E:(w?e.__c=r=new S(h,H):(e.__c=r=new z(h,H),r.constructor=S,r.render=Je),M&&M.sub(r),r.state||(r.state={}),r.__n=i,c=r.__d=!0,r.__h=[],r._sb=[]),w&&r.__s==null&&(r.__s=r.state),w&&S.getDerivedStateFromProps!=null&&(r.__s==r.state&&(r.__s=C({},r.__s)),C(r.__s,S.getDerivedStateFromProps(h,r.__s))),m=r.props,k=r.state,r.__v=e,c)w&&S.getDerivedStateFromProps==null&&r.componentWillMount!=null&&r.componentWillMount(),w&&r.componentDidMount!=null&&r.__h.push(r.componentDidMount);else{if(w&&S.getDerivedStateFromProps==null&&h!==m&&r.componentWillReceiveProps!=null&&r.componentWillReceiveProps(h,H),e.__v==n.__v||!r.__e&&r.shouldComponentUpdate!=null&&r.shouldComponentUpdate(h,r.__s,H)===!1){e.__v!=n.__v&&(r.props=h,r.state=r.__s,r.__d=!1),e.__e=n.__e,e.__k=n.__k,e.__k.some(function(T){T&&(T.__=e)}),W.push.apply(r.__h,r._sb),r._sb=[],r.__h.length&&s.push(r),l=P(n);break e}r.componentWillUpdate!=null&&r.componentWillUpdate(h,r.__s,H),w&&r.componentDidUpdate!=null&&r.__h.push(function(){r.componentDidUpdate(m,k,x)})}if(r.context=H,r.props=h,r.__P=t,r.__e=!1,U=f.__r,ae=0,w)r.state=r.__s,r.__d=!1,U&&U(e),p=r.render(r.props,r.state,r.context),W.push.apply(r.__h,r._sb),r._sb=[];else do r.__d=!1,U&&U(e),p=r.render(r.props,r.state,r.context),r.state=r.__s;while(r.__d&&++ae<25);r.state=r.__s,r.getChildContext!=null&&(i=C(C({},i),r.getChildContext())),w&&!c&&r.getSnapshotBeforeUpdate!=null&&(x=r.getSnapshotBeforeUpdate(m,k)),N=p!=null&&p.type===A&&p.key==null?xe(p.props.children):p,l=be(t,O(N)?N:[N],e,n,i,_,o,s,l,u,a),r.base=e.__e,e.__u&=-161,r.__h.length&&s.push(r),y&&(r.__E=r.__=null)}catch(T){if(s.length=d,e.__v=null,u||o!=null){if(T.then){for(e.__u|=u?160:128;l&&l.nodeType==8&&l.nextSibling;)l=l.nextSibling;o!=null&&(o[o.indexOf(l)]=null),e.__e=l}else if(o!=null)for(q=o.length;q--;)Q(o[q])}else e.__e=n.__e;e.__k==null&&(e.__k=n.__k||[]),T.then||ge(e),f.__e(T,e,n)}}else o==null&&e.__v==n.__v?(e.__k=n.__k,e.__e=n.__e):l=e.__e=qe(n.__e,e,n,i,_,o,s,u,a);return(p=f.diffed)&&p(e),128&e.__u?void 0:l}function ge(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(ge))}function ye(t,e,n){for(var i=0;i<n.length;i++)Z(n[i],n[++i],n[++i]);f.__c&&f.__c(e,t),t.some(function(_){try{t=_.__h,_.__h=[],t.some(function(o){o.call(_)})}catch(o){f.__e(o,_.__v)}})}function xe(t){return typeof t!="object"||t==null||t.__b>0?t:O(t)?t.map(xe):t.constructor!==void 0?null:C({},t)}function qe(t,e,n,i,_,o,s,l,u){var a,p,d,r,c,m,k,x=n.props||$,y=e.props,h=e.type;if(h=="svg"?_="http://www.w3.org/2000/svg":h=="math"?_="http://www.w3.org/1998/Math/MathML":_||(_="http://www.w3.org/1999/xhtml"),o!=null){for(a=0;a<o.length;a++)if((c=o[a])&&"setAttribute"in c==!!h&&(h?c.localName==h:c.nodeType==3)){t=c,o[a]=null;break}}if(t==null){if(h==null)return document.createTextNode(y);t=document.createElementNS(_,h,y.is&&y),l&&(f.__m&&f.__m(e,o),l=!1),o=null}if(h==null)x===y||l&&t.data==y||(t.data=y);else{if(o=h=="textarea"&&y.defaultValue!=null?null:o&&B.call(t.childNodes),!l&&o!=null)for(x={},a=0;a<t.attributes.length;a++)x[(c=t.attributes[a]).name]=c.value;for(a in x)c=x[a],a=="dangerouslySetInnerHTML"?d=c:a=="children"||a in y||a=="value"&&"defaultValue"in y||a=="checked"&&"defaultChecked"in y||j(t,a,null,c,_);for(a in y)c=y[a],a=="children"?r=c:a=="dangerouslySetInnerHTML"?p=c:a=="value"?m=c:a=="checked"?k=c:l&&typeof c!="function"||x[a]===c||j(t,a,c,x[a],_);if(p)l||d&&(p.__html==d.__html||p.__html==t.innerHTML)||(t.innerHTML=p.__html),e.__k=[];else if(d&&(t.innerHTML=""),be(e.type=="template"?t.content:t,O(r)?r:[r],e,n,i,h=="foreignObject"?"http://www.w3.org/1999/xhtml":_,o,s,o?o[0]:n.__k&&P(n,0),l,u),o!=null)for(a=o.length;a--;)Q(o[a]);l&&h!="textarea"||(a="value",h=="progress"&&m==null?t.removeAttribute("value"):m!=null&&(m!==t[a]||h=="progress"&&!m||h=="option"&&m!=x[a])&&j(t,a,m,x[a],_),a="checked",k!=null&&k!=t[a]&&j(t,a,k,x[a],_))}return t}function Z(t,e,n){try{if(typeof t=="function"){var i=typeof t.__u=="function";i&&t.__u(),i&&e==null||(t.__u=t(e))}else t.current=e}catch(_){f.__e(_,n)}}function ke(t,e,n){var i,_;if(f.unmount&&f.unmount(t),(i=t.ref)&&(i.current&&i.current!=t.__e||Z(i,null,e)),(i=t.__c)!=null){if(i.componentWillUnmount)try{i.componentWillUnmount()}catch(o){f.__e(o,e)}i.base=i.__P=i.__n=null}if(i=t.__k)for(_=0;_<i.length;_++)i[_]&&ke(i[_],e,n||typeof t.type!="function");n||Q(t.__e),t.__c=t.__=t.__e=void 0}function Je(t,e,n){return this.constructor(t,n)}function we(t,e,n){var i,_,o,s;e==document&&(e=document.documentElement),f.__&&f.__(t,e),_=(i=typeof n=="function")?null:n&&n.__k||e.__k,o=[],s=[],X(e,t=(!i&&n||e).__k=Le(A,null,[t]),_||$,$,e.namespaceURI,!i&&n?[n]:_?null:e.firstChild?B.call(e.childNodes):null,o,!i&&n?n:_?_.__e:e.firstChild,i,s),ye(o,t,s),t.props.children=null}B=W.slice,f={__e:function(t,e,n,i){for(var _,o,s;e=e.__;)if((_=e.__c)&&!_.__)try{if((o=_.constructor)&&o.getDerivedStateFromError!=null&&(_.setState(o.getDerivedStateFromError(t)),s=_.__d),_.componentDidCatch!=null&&(_.componentDidCatch(t,i||{}),s=_.__d),s)return _.__E=_}catch(l){t=l}throw t}},pe=0,ze=function(t){return t!=null&&t.constructor===void 0},z.prototype.setState=function(t,e){var n;n=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=C({},this.state),typeof t=="function"&&(t=t(C({},n),this.props)),t&&C(n,t),t!=null&&this.__v&&(e&&this._sb.push(e),le(this))},z.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),le(this))},z.prototype.render=A,E=[],fe=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,he=function(t,e){return t.__v.__b-e.__v.__b},L.__r=0,J=Math.random().toString(8),F="__d"+J,D="__a"+J,de=/(PointerCapture)$|Capture$/i,G=0,K=ue(!1),Y=ue(!0),$e=0;var te,v,ee,Se,ne=0,Ue=[],g=f,Ce=g.__b,Ee=g.__r,Ae=g.diffed,He=g.__c,Pe=g.unmount,Te=g.__;function Ke(t,e){g.__h&&g.__h(v,t,ne||e),ne=0;var n=v.__H||(v.__H={__:[],__h:[]});return t>=n.__.length&&n.__.push({}),n.__[t]}function I(t){return ne=1,Ye(De,t)}function Ye(t,e,n){var i=Ke(te++,2);if(i.t=t,!i.__c&&(i.__=[n?n(e):De(void 0,e),function(l){var u=i.__N?i.__N[0]:i.__[0],a=i.t(u,l);u!==a&&(i.__N=[a,i.__[1]],i.__c.setState({}))}],i.__c=v,!v.__f)){var _=function(l,u,a){if(!i.__c.__H)return!0;var p=!1,d=i.__c.props!==l;if(i.__c.__H.__.some(function(c){if(c.__N){p=!0;var m=c.__[0];c.__=c.__N,c.__N=void 0,m!==c.__[0]&&(d=!0)}}),o){var r=o.call(this,l,u,a);return p?r||d:r}return!p||d};v.__f=!0;var o=v.shouldComponentUpdate,s=v.componentWillUpdate;v.componentWillUpdate=function(l,u,a){if(this.__e){var p=o;o=void 0,_(l,u,a),o=p}s&&s.call(this,l,u,a)},v.shouldComponentUpdate=_}return i.__N||i.__}function Ge(){for(var t;t=Ue.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(V),e.__h.some(re),e.__h=[]}catch(n){e.__h=[],g.__e(n,t.__v)}}}g.__b=function(t){v=null,Ce&&Ce(t)},g.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),Te&&Te(t,e)},g.__r=function(t){Ee&&Ee(t),te=0;var e=(v=t.__c).__H;e&&(ee===v?(e.__h=[],v.__h=[],e.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})):(e.__h.some(V),e.__h.some(re),e.__h=[],te=0)),ee=v},g.diffed=function(t){Ae&&Ae(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(Ue.push(e)!==1&&Se===g.requestAnimationFrame||((Se=g.requestAnimationFrame)||Qe)(Ge)),e.__H.__.some(function(n){n.u&&(n.__H=n.u,n.u=void 0)})),ee=v=null},g.__c=function(t,e){e.some(function(n){try{n.__h.some(V),n.__h=n.__h.filter(function(i){return!i.__||re(i)})}catch(i){e.some(function(_){_.__h&&(_.__h=[])}),e=[],g.__e(i,n.__v)}}),He&&He(t,e)},g.unmount=function(t){Pe&&Pe(t);var e,n=t.__c;n&&n.__H&&(n.__H.__.some(function(i){try{V(i)}catch(_){e=_}}),n.__H=void 0,e&&g.__e(e,n.__v))};var Me=typeof requestAnimationFrame=="function";function Qe(t){var e,n=function(){clearTimeout(i),Me&&cancelAnimationFrame(e),setTimeout(t)},i=setTimeout(n,35);Me&&(e=requestAnimationFrame(n))}function V(t){var e=v,n=t.__c;typeof n=="function"&&(t.__c=void 0,n()),v=e}function re(t){var e=v;t.__c=t.__(),v=e}function De(t,e){return typeof e=="function"?e(t):e}var Ie=(t,...e)=>String.raw({raw:t},...e);var Ne=Ie`
    html,
    body {
      margin: 0;
      height: 100%;
    }
    iframe.native-album {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
    }
    #immich-shared-albums-banner .card {
      position: fixed;
      z-index: 2147483000;
      right: 24px;
      bottom: 24px;
      width: 400px;
      max-width: calc(100vw - 32px);
      box-sizing: border-box;
      font-family: 'Overpass', 'Inter', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #ffffff;
      color: #202124;
      border: 1px solid rgba(0, 0, 0, 0.06);
      border-radius: 28px;
      box-shadow: 0 1px 3px rgba(60, 64, 67, 0.15), 0 8px 28px rgba(60, 64, 67, 0.22);
      padding: 22px 22px 18px;
      animation: isa-in 0.35s cubic-bezier(0.21, 1.02, 0.73, 1) both;
    }
    @media (max-width: 560px) {
      #immich-shared-albums-banner .card {
        right: 0;
        bottom: 0;
        left: 0;
        width: auto;
        max-width: none;
        border-radius: 28px 28px 0 0;
        padding-bottom: max(18px, env(safe-area-inset-bottom));
        animation-name: isa-in-sheet;
      }
    }
    @keyframes isa-in {
      from {
        opacity: 0;
        transform: translateY(14px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @keyframes isa-in-sheet {
      from {
        transform: translateY(100%);
      }
      to {
        transform: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #immich-shared-albums-banner .card {
        animation: none;
      }
    }
    #immich-shared-albums-banner .row {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding-right: 26px;
    }
    #immich-shared-albums-banner .logo {
      flex: none;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #4250af, #7c3aed);
      box-shadow: 0 2px 8px rgba(66, 80, 175, 0.35);
    }
    #immich-shared-albums-banner .logo svg {
      width: 22px;
      height: 22px;
    }
    #immich-shared-albums-banner h2 {
      margin: 2px 0 5px;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    #immich-shared-albums-banner .sub {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: #5f6368;
    }
    #immich-shared-albums-banner form {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }
    #immich-shared-albums-banner input {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      font: inherit;
      font-size: 14px;
      padding: 11px 18px;
      border-radius: 999px;
      border: 1px solid transparent;
      background: #f1f3f4;
      color: inherit;
      outline: none;
      transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    }
    #immich-shared-albums-banner input:focus {
      background: #fff;
      border-color: #4250af;
      box-shadow: 0 0 0 3px rgba(66, 80, 175, 0.15);
    }
    #immich-shared-albums-banner button.join {
      flex: none;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      padding: 11px 22px;
      border: 0;
      border-radius: 999px;
      cursor: pointer;
      background: #4250af;
      color: #fff;
      transition: filter 0.15s, box-shadow 0.15s, transform 0.05s;
    }
    #immich-shared-albums-banner button.join:hover {
      filter: brightness(1.08);
      box-shadow: 0 2px 10px rgba(66, 80, 175, 0.4);
    }
    #immich-shared-albums-banner button.join:active {
      transform: scale(0.97);
    }
    #immich-shared-albums-banner .dismiss {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 32px;
      height: 32px;
      box-sizing: border-box;
      border: 0;
      border-radius: 50%;
      background: none;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      color: #5f6368;
      padding: 0;
      display: grid;
      place-items: center;
      transition: background 0.15s;
    }
    #immich-shared-albums-banner .dismiss:hover {
      background: rgba(0, 0, 0, 0.06);
    }
    #immich-shared-albums-banner .err {
      margin: 10px 0 0;
      font-size: 12.5px;
      color: #d93025;
    }
    #immich-shared-albums-banner .hint {
      margin: 14px 0 0;
      font-size: 12px;
      line-height: 1.55;
      color: #80868b;
    }
    #immich-shared-albums-banner .hint a {
      color: #4250af;
      text-decoration: none;
    }
    #immich-shared-albums-banner .hint a:hover {
      text-decoration: underline;
    }
    @media (prefers-color-scheme: dark) {
      #immich-shared-albums-banner .card {
        background: #1b1f26;
        color: #e8eaed;
        border-color: rgba(255, 255, 255, 0.08);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4), 0 10px 32px rgba(0, 0, 0, 0.5);
      }
      #immich-shared-albums-banner .sub {
        color: #9aa0a6;
      }
      #immich-shared-albums-banner input {
        background: #262b33;
        color: #e8eaed;
      }
      #immich-shared-albums-banner input::placeholder {
        color: #7d8590;
      }
      #immich-shared-albums-banner input:focus {
        background: #2a3038;
      }
      #immich-shared-albums-banner .dismiss {
        color: #9aa0a6;
      }
      #immich-shared-albums-banner .dismiss:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      #immich-shared-albums-banner .hint {
        color: #7d8590;
      }
      #immich-shared-albums-banner .hint a {
        color: #a8c7fa;
      }
      #immich-shared-albums-banner button.join {
        background: #a8c7fa;
        color: #0d1b3d;
      }
    }
  `;var Xe=0;function b(t,e,n,i,_,o){e||(e={});var s,l,u=e;if("ref"in u)for(l in u={},e)l=="ref"?s=e[l]:u[l]=e[l];var a={type:t,props:u,key:n,ref:s,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--Xe,__i:-1,__u:0,__source:_,__self:o};if(typeof t=="function"&&(s=t.defaultProps))for(l in s)u[l]===void 0&&(u[l]=s[l]);return f.vnode&&f.vnode(a),a}var je="isa-my-server",Ze=5e3,Fe=()=>location.pathname.split("/share/")[1]?.split(/[/?#]/)[0]??"",et=()=>location.assign(`${location.pathname}?native=1`),oe=t=>!(location.protocol==="https:"&&t==="http"),ie=async(t,e)=>{try{let n=await fetch(`${t}://${e}/immich-shared-albums/health`,{signal:AbortSignal.timeout(Ze)});return n.ok&&(await n.json()).ok===!0}catch{return!1}},Re=()=>{let[t,e]=I(localStorage.getItem(je)??""),[n,i]=I(!1),[_,o]=I(""),[s,l]=I(!1),u=async p=>{p.preventDefault();let d=t.trim();if(!d)return;let r=/^https:\/\//i.test(d)?"https":/^http:\/\//i.test(d)?"http":null,c=d.replace(/^https?:\/\//i,"").replace(/\/.*$/,"");o(""),i(!0);let m=!1;if(r?m=oe(r)?await ie(r,c):!0:await ie("https",c)?(r="https",m=!0):oe("http")&&await ie("http",c)?(r="http",m=!0):(r="https",m=!oe("http")&&location.protocol!=="https:"),i(!1),!m){o(`Couldn't find the shared-albums addon at ${c} \u2014 use the address your Immich is served on (with the sidecar routes). Direct setups without a reverse proxy need the sidecar port, not the Immich one.`);return}localStorage.setItem(je,d);let k=encodeURIComponent(JSON.stringify({v:1,host:location.host,scheme:location.protocol.replace(":",""),key:Fe()}));location.href=`${r}://${c}/immich-shared-albums/accept#${k}`},a=Fe();return b(A,{children:[b("style",{children:Ne}),b("iframe",{class:"native-album",src:`/share/${a}?native=1`,title:"Shared album"}),!s&&b("div",{class:"card",role:"dialog","aria-label":"Join this album with your own Immich server",children:[b("button",{class:"dismiss","aria-label":"Continue to the album",onClick:()=>{l(!0),et()},children:"\xD7"}),b("div",{class:"row",children:[b("div",{class:"logo","aria-hidden":"true",children:b("svg",{viewBox:"0 0 24 24",fill:"none",stroke:"#fff","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round",children:[b("path",{d:"M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"}),b("path",{d:"M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"})]})}),b("div",{children:[b("h2",{children:"Join shared album with your server?"}),b("p",{class:"sub",children:["Have an Immich server of your own with the shared-albums addon?",b("br",{}),"If so pop your server address down below to begin sharing photos across servers!"]})]})]}),b("form",{onSubmit:u,children:[b("input",{type:"text",inputMode:"url",autocomplete:"off",autocapitalize:"none",spellcheck:!1,placeholder:"your-server.example.com","aria-label":"Your server address",value:t,onInput:p=>e(p.target.value)}),b("button",{class:"join",type:"submit",disabled:n,children:n?"Checking\u2026":"Join"})]}),_&&b("p",{class:"err",children:_}),b("p",{class:"hint",children:["Type your server address once \u2014 it's remembered for next time. Nothing to install for viewing.",b("br",{}),"Want this for your own server?"," ",b("a",{href:"https://github.com/lukeet332/immich-shared-albums",target:"_blank",rel:"noopener",children:"github.com/lukeet332/immich-shared-albums"})]})]})]})};var _e=document.getElementById("share-app");_e&&(_e.id="immich-shared-albums-banner",we(b(Re,{}),_e));
