const __NodeBuffer = Buffer;
delete navigator;
delete crypto;

process_ = process;
require_ = require;
// Keep Node's Buffer available while loading crypto-js on Node 26.
delete process;
delete require;
delete global;
delete module;
delete exports;
delete __filename;
delete __dirname;
delete setImmediate;
delete clearImmediate;
delete SharedArrayBuffer;
// 6deb0ed2ad1f787504bfb0221de263c3585ec17647a89fe799
// 6deb0ed2ad1f787504bfb0221de263c3585ec17647a89fe799

const v8 = require_('v8');
const vm=require_('vm');
v8.setFlagsFromString('--allow-natives-syntax');
let undetectable = vm.runInThisContext("%GetUndetectable()");
v8.setFlagsFromString('--no-allow-natives-syntax');


AsObj = {
    print: console.log,
    print: function () { },
    print_:console.log,
}
console.log = function () { }

undefined_list = []
no_print = ['Boolean','String','parseFloat','Array','Object'];
function watch(object, WatchName) {
    const handler = {
      get(target, property, receiver) {
        if (
          property !== 'isNaN' &&
          property !== 'encodeURI' &&
          property !== "Uint8Array" &&
          property !== 'undefined' &&
          property !== 'JSON' &&
          property !== 'Number' &&
          !no_print.includes(property) &&
            property !== Symbol.for('nodejs.util.inspect.custom') &&
            typeof property !== 'symbol'
        ) {

            if (property === 'global') {
              return undefined;
            }
            if (property === 'Buffer') {
              return undefined;
            }
            if (property === 'process') {
                return undefined;
            }
            if (WatchName.indexOf('.prototype') != -1 && target[property] != undefined) {
                return Reflect.get(target, property, receiver);
            } else {
                und_names = WatchName + property;
                if(undefined_list.includes(und_names)){
                    return Reflect.get(target, property, receiver);
                } else {
                    undefined_list.push(und_names);
                }
            }

            AsObj.print(
            "方法:", "get", 
            "对象:", WatchName, 
            "属性:", property, 
            "属性类型:", typeof property, 
            "属性值:", typeof target[property] == 'object' ? "object" : target[property], 
            "属性值类型:", typeof target[property]
          );
        }
        
        if (WatchName === 'top') {
            return window;
        }
            
        return Reflect.get(target, property, receiver);
      },
  
    set(target, property, value, receiver) {
        if (WatchName.indexOf('.prototype') != -1 && value != undefined) {
            return Reflect.set(target, property, value, receiver);
        }
        AsObj.print(
          "方法:", "set", 
          "对象:", WatchName, 
          "属性:", property, 
          "属性类型:", typeof property, 
          "属性值:", typeof value == 'object' ? "object" : value,
          "属性值类型:", typeof target[property]
        );
        return Reflect.set(target, property, value, receiver);
      },
      // in操作 检测 
      has(target, property) {
        AsObj.print(
          "代理对象:", WatchName,
          "方法:", "has",
          "检查属性:", property,
          "结果:", typeof target[property] == 'object' ? "object" : target[property], 
        );
        return Reflect.has(target, property);
      },
      // Object.key 检测 	
    ownKeys(target) {
        AsObj.print(
          "方法:", "ownKeys",
          "对象:", target+''
        );
        return Reflect.ownKeys(target);
      }
    };
  
    return new Proxy(object, handler);
}
function watch(object, WatchName) {
    return object
}

// 保护函数，toString检测
const safeFunction = function safeFunction(func) {
    //处理安全函数
    Function.prototype.$call = Function.prototype.call;
    const $toString = Function.toString;
    const myFunction_toString_symbol = Symbol('('.concat('', ')'));
   
    const myToString = function myToString() {
      return typeof this === 'function' && this[myFunction_toString_symbol] || $toString.$call(this);
    }
   
    const set_native = function set_native(func, key, value) {
      Object.defineProperty(func, key, {
        "enumerable": false,
        "configurable": true,
        "writable": true,
        "value": value
      });
    }
   
    delete Function.prototype['toString'];
    set_native(Function.prototype, "toString", myToString);
    set_native(Function.prototype.toString, myFunction_toString_symbol, "function toString() { [native code] }");
   
    const safe_Function = function safe_Function(func) {
      set_native(func, myFunction_toString_symbol, "function" + (func.name ? " " + func.name : "") + "() { [native code] }");
    }
   
    return safe_Function(func)
}

//创建函数，并代理上
const makeFunction = function makeFunction(name) {
    v_log = AsObj.print_;
    // 使用 Function 保留函数名
    func = new Function("v_log", `
          return function ${name}() {
              v_log('函数${name}传参-->', arguments);
          };
      `)(v_log); // 传递 v_log 到动态函数
   
    safeFunction(func);
    func.prototype = watch(func.prototype, `${name}.prototype`);
   
    return func;
}

!(function () {
    "use strict";
    const $toString = Function.toString;
    const myFunction_toString_symbol = Symbol('('.concat('', ')_', (Math.random() + '').toString(36)));
    const mytoString = function () {
        return typeof this == 'function' && this[myFunction_toString_symbol] || $toString.call(this);
    };

    function set_native(func, key, value) {
        Object.defineProperty(func, key, {
            "enumerable": false,
            "configurable": true,
            "writable": true,
            "value": value
        })
    };
    delete Function.prototype['toString'];
    set_native(Function.prototype, "toString", mytoString);
    set_native(Function.prototype.toString, myFunction_toString_symbol, "function toString() { [native code] }");
    this.func_set_native = function (func) {
        set_native(func, myFunction_toString_symbol, `function ${myFunction_toString_symbol, func.name || ''}() { [native code] }`)
    }
}).call(globalThis);

// 重写全局对象原型链
function setTostringAndstringTag(obj) {
    Object.defineProperties(obj.prototype, {
        [Symbol.toStringTag]: {
            configurable: true,
            value: obj.name
        }
    });
    safeFunction(obj);
};

// 创建标签原型
function createTagProto(propObj,portotypeObj) {
    let res = propObj + ' = ' + 'function ' + propObj + '() { throw new TypeError("Illegal constructor"); };\n';
    res += 'setTostringAndstringTag(' + propObj + ',null);\n';
    if (portotypeObj) {
        for (let key in portotypeObj) {
            res += propObj + '.prototype.' + portotypeObj[key] + '= function ' + portotypeObj[key] + '() {};\n';
            res += 'globalThis.func_set_native(' + propObj + '.prototype.' + portotypeObj[key] + ');\n';
        }
    }
    eval(res);
}

Object.defineProperties(globalThis, {
    [Symbol.toStringTag]: {
        configurable: true,
        value: 'Window'
    }
});

createTagProto('EventTarget',['addEventListener']);
createTagProto('WindowProperties');
createTagProto('Window');

window = globalThis;
window.__proto__ = Window.prototype;
window.__proto__.__proto__ = WindowProperties.prototype;
window.__proto__.__proto__.__proto__ = EventTarget.prototype;
Window.__proto__ = EventTarget;

Object.defineProperty(window, 'WindowProperties', {
    get: function () {
        return undefined;
    }
})

self = window.self = window;
frames = window.frames = window;
top = window.top = window;
parent = window.parent = window;

window[0] = window

Object.defineProperty(window, "top", {
    configurable:false,
    enumerable: true,
    set: undefined,
    get: function top(){
        return window
    }
})
Object.defineProperty(window, "self", {
    configurable:false,
    enumerable: true,
    set: undefined,
    get: function self(){
        return window
    }
})
Object.defineProperty(window, "0", {
    configurable:false,
    enumerable: true,
    set: undefined,
    get: function (){
        return window
    }
})
Object.defineProperty(window, "parent", {
    configurable:false,
    enumerable: true,
    set: undefined,
    get: function parent(){
        return window
    }
})
Object.defineProperty(window, "frames", {
    configurable:false,
    enumerable: true,
    set: undefined,
    get: function frames(){
        return window
    }
})

innerWidth = 891
innerHeight = 1280
outerWidth = 975
outerHeight = 1280
devicePixelRatio = 1.5;
screenLeft = 0;
screenX = 0;
screenTop = 0;
screenY = 0;
opener = null;
isSecureContext = true;
fence = null;
sharedStorage = watch({}, 'sharedStorage')
originAgentCluster = true

CSSRuleList = makeFunction('CSSRuleList');
DOMRectList = makeFunction('DOMRectList');
DOMStringList = makeFunction('DOMStringList');
DataTransferItemList = makeFunction('DataTransferItemList');
FileList = makeFunction('FileList');
HTMLCollection = makeFunction('HTMLCollection');
HTMLFormElement = makeFunction('HTMLFormElement');
HTMLSelectElement = makeFunction('HTMLSelectElement');
MediaList = makeFunction('MediaList');
NamedNodeMap = makeFunction('NamedNodeMap');
createTagProto('NodeList');
NodeList.prototype.values = function values() {
    AsObj.print("values:", arguments);
}
NodeList.prototype.keys = function keys() {
    AsObj.print("keys:", arguments);
}
NodeList.prototype.entries = function entries() {
    AsObj.print("entries:", arguments);
}
print = makeFunction('print');
RTCStatsReport = makeFunction('RTCStatsReport');
RemotePlayback = makeFunction('RemotePlayback');
RemotePlayback.prototype.cancelWatchAvailability = function cancelWatchAvailability() {
    AsObj.print("cancelWatchAvailability:", arguments);
}
safeFunction(RemotePlayback.prototype.cancelWatchAvailability);
MutationRecord = makeFunction('MutationRecord');
VisualViewport = makeFunction('VisualViewport');
VisualViewport.prototype.pageTop = 0;
safeFunction(NodeList.prototype.values);
safeFunction(NodeList.prototype.keys);
safeFunction(NodeList.prototype.entries);
SVGLengthList = makeFunction('SVGLengthList');
SVGNumberList = makeFunction('SVGNumberList');
SVGPointList = makeFunction('SVGPointList');
SVGStringList = makeFunction('SVGStringList');
SVGTransformList = makeFunction('SVGTransformList');
SourceBufferList = makeFunction('SourceBufferList');
StyleSheetList = makeFunction('StyleSheetList');
TextTrackCueList = makeFunction('TextTrackCueList');
TextTrackList = makeFunction('TextTrackList');
TouchList = makeFunction('TouchList');
CSSStyleDeclaration = makeFunction('CSSStyleDeclaration');
CSSStyleDeclaration.prototype.display = ''
CSSStyleDeclaration.prototype.color = ''
CSSStyleDeclaration.prototype.hyphenateCharacter = ''
CSSStyleDeclaration.prototype.offsetPath = ''
CSSStyleDeclaration.prototype.cursor = ''
HTMLSpanElement = makeFunction('HTMLSpanElement');
createTagProto('DOMTokenList');
DOMTokenList.prototype.values = function values() {
    AsObj.print("values:", arguments);
}
DOMTokenList.prototype.keys = function keys() {
    AsObj.print("keys:", arguments);
}
DOMTokenList.prototype.entries = function entries() {
    AsObj.print("entries:", arguments);
}
safeFunction(DOMTokenList.prototype.values);
safeFunction(DOMTokenList.prototype.keys);
safeFunction(DOMTokenList.prototype.entries);
span_classList = [];
span_classList.__proto__ = DOMTokenList.prototype;
span = {
    classList:watch(span_classList,'span_classList')
};
span.__proto__ = HTMLSpanElement.prototype;

createTagProto('HTMLIFrameElement');
iframe = {
    __proto__: HTMLIFrameElement.prototype,
    tagName: 'IFRAME',
    style: watch({
        __proto__: CSSStyleDeclaration.prototype,
        cssText: '',
        setProperty:function(key,value){
            this[key] = value
        },
        parentNode: { removeChild: function (obj) { return obj } }
    }, 'iframe.style'),
    contentWindow:new Proxy(window, {
        get: function (target, property) {
            // debugger
            if (property === Symbol.toPrimitive) {
                return window
            }
            // 如果属性存在于window上，返回window的属性
            else if (property in window) {
                if (property + '' === 'top') {
                    top_ = watche({}, "top_")
                    return top_;
                }
                return window[property];
            }
            // 否则返回undefined或者自定义的默认值
            return undefined;
        },
        set: function (target, property, value) {
            debugger
            // 如果属性存在于window上，设置window的属性
            if (property in window) {
                window[property] = value;
            } else {
                // 否则设置到fakeWindow上
                target[property] = value;
            }
            return true;
        }
    }),
}

WebGLShaderPrecisionFormat = function WebGLShaderPrecisionFormat() {
    this.rangeMin = 127;
    this.rangeMax = 127;
    this.precision = 23;
}
safeFunction(WebGLShaderPrecisionFormat);
createTagProto('WebGLRenderingContext');
webgl = {
    canvas: {
        toDataURL: function () {
            return 'data:image/png;base64,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'
      }  
    },
    getSupportedExtensions : function getSupportedExtensions() {
        return [
            "EXT_color_buffer_float",
            "EXT_color_buffer_half_float",
            "EXT_disjoint_timer_query_webgl2",
            "EXT_float_blend",
            "EXT_texture_compression_bptc",
            "EXT_texture_compression_rgtc",
            "EXT_texture_filter_anisotropic",
            "EXT_texture_norm16",
            "KHR_parallel_shader_compile",
            "OES_draw_buffers_indexed",
            "OES_texture_float_linear",
            "OVR_multiview2",
            "WEBGL_compressed_texture_s3tc",
            "WEBGL_compressed_texture_s3tc_srgb",
            "WEBGL_debug_renderer_info",
            "WEBGL_debug_shaders",
            "WEBGL_lose_context",
            "WEBGL_multi_draw",
            "WEBGL_provoking_vertex"
        ]
    },
    getExtension: function () {
        AsObj.print("getExtension:", arguments[0]);
        if (arguments[0] === 'EXT_texture_filter_anisotropic') {
            return {
                MAX_TEXTURE_MAX_ANISOTROPY_EXT: 34047,
                TEXTURE_MAX_ANISOTROPY_EXT: 34046
            }
        }
        if (arguments[0] === 'WEBGL_debug_renderer_info') {
            return {
                UNMASKED_RENDERER_WEBGL: 37446,
                UNMASKED_VENDOR_WEBGL: 37445
            }
        }
    },
    getParameter: function getParameter() {
        res = arguments[0]
        AsObj.print("getParameter:", res);
        if (res + '' === '37445') {
            return 'Google Inc. (Intel)'
        }
        if (res + '' === '37446') {
            return 'ANGLE (Intel, Intel(R) UHD Graphics (0x00008A56) Direct3D11 vs_5_0 ps_5_0, D3D11)'
        }
        if (res + '' === '34047') {
            return 16
        }
        if (res + '' === '34046') {
            return null
        }
        if (res + '' === '3379') {
            return 16384
        }
        if (res + '' === '34930') {
            return 16
        }
        if (res + '' === '36347') {
            return 4096
        }
        if (res + '' === '35660') {
            return 16
        }
        if (res === 33902) {
            return Float32Array.from([1,1])
        }
        if (res === 33901) {
            return Float32Array.from([1,1024])
        }
        if (res + '' === '3413') {
            return 8
        }
        if (res + '' === '3412') {
            return 8
        }
        if (res + '' === '3414') {
            return 24
        }
        if (res + '' === '3411') {
            return 8
        }
        if (res + '' === '34047') {
            return 16
        }
        if (res + '' === '35661') {
            return 32
        }
        if (res + '' === '34076') {
            return 16384
        }
        if (res + '' === '36349') {
            return 1024
        }
        if (res + '' === '34024') {
            return 16384
        }
        if (res + '' === '36348') {
            return 30
        }
        if (res + '' === '34921') {
            return 16
        }
        if (res + '' === '3410') {
            return 8
        }
        if (res + '' === '7937') {
            return 'WebKit WebGL'
        }
        if (res + '' === '35724') {
            return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'
        }
        if (res + '' === '3415') {
            return 0
        }
        if (res + '' === '7936') {
            return 'WebKit'
        }
        if (res + '' === '7938') {
            return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'
        }
        if (res + '' === '3386') {
            return Int32Array.from([32767, 32767])
        }
    },
    createBuffer: function () {
        return {
            name: 'webgl_buffer',
            itemSize: 3,
            numItems:3
        }
    },
    bindBuffer: function () { },
    STATIC_DRAW: 35044,
    ARRAY_BUFFER: 34962,
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    FLOAT: 5126,
    TRIANGLE_STRIP: 5,
    createProgram: function () {
        return watch({
            vertexPosAttrib: 0
        },'createProgram')
    },
    getUniformLocation: function () {
        return watch({},'getUniformLocation')
    },
    getAttribLocation: function () {
      return 0;  
    },
    createShader: function () {
        return watch({},'createShader')
    },
    shaderSource: function () { },
    compileShader: function () { },
    attachShader: function () { },
    linkProgram: function () { },
    useProgram: function () { },
    bufferData: function () { },
    enableVertexAttribArray: function () { },
    vertexAttribPointer: function () { },
    drawArrays: function () { },
    uniform2f: function () { },
    clearColor: function () { },
    DEPTH_TEST: 2929,
    depthFunc: function () { },
    LEQUAL: 515,
    clear: function () { },
    COLOR_BUFFER_BIT: 16384,
    DEPTH_BUFFER_BIT:256,
    enable: function () { },
    ALIASED_LINE_WIDTH_RANGE: 33902,
    ALIASED_POINT_SIZE_RANGE: 33901,
    ALPHA_BITS: 3413,
    BLUE_BITS: 3412,
    DEPTH_BITS: 3414,
    GREEN_BITS: 3411,
    getContextAttributes: function () {
        return {
            "alpha": true,
            "antialias": true,
            "depth": true,
            "desynchronized": false,
            "failIfMajorPerformanceCaveat": false,
            "powerPreference": "default",
            "premultipliedAlpha": true,
            "preserveDrawingBuffer": false,
            "stencil": false,
            "xrCompatible": false
        }
    },
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
    MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
    MAX_FRAGMENT_UNIFORM_VECTORS: 36349,
    MAX_RENDERBUFFER_SIZE: 34024,
    MAX_TEXTURE_IMAGE_UNITS: 34930,
    MAX_TEXTURE_SIZE: 3379,
    MAX_VARYING_VECTORS: 36348,
    MAX_VERTEX_ATTRIBS: 34921,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660,
    MAX_VERTEX_UNIFORM_VECTORS: 36347,
    MAX_VIEWPORT_DIMS: 3386,
    RED_BITS: 3410,
    RENDERER: 7937,
    SHADING_LANGUAGE_VERSION: 35724,
    STENCIL_BITS: 3415,
    VENDOR: 7936,
    VERSION: 7938,
    HIGH_FLOAT: 36338,
    MEDIUM_FLOAT: 36337,
    LOW_FLOAT: 36336,
    MEDIUM_INT: 36340,
    LOW_INT: 36339,
    HIGH_INT: 36341,
    getShaderPrecisionFormat: function () {
        AsObj.print("getShaderPrecisionFormat:", arguments[0], arguments[1]);
        if (arguments[0] === 35633 && arguments[1] === 36338) {
            return new WebGLShaderPrecisionFormat()
        }
        if (arguments[0] === 35633 && arguments[1] === 36337) {
            return new WebGLShaderPrecisionFormat()
        }
        if (arguments[0] === 35633 && arguments[1] === 36336) {
            return new WebGLShaderPrecisionFormat()
        }
        if (arguments[0] === 35632 && arguments[1] === 36338) {
            return new WebGLShaderPrecisionFormat()
        }
        if (arguments[0] === 35632 && arguments[1] === 36337) {
            return new WebGLShaderPrecisionFormat()
        }
        if (arguments[0] === 35632 && arguments[1] === 36336) {
            return new WebGLShaderPrecisionFormat()
        }
        if (arguments[0] === 35633 && arguments[1] === 36341) {
            obj = new WebGLShaderPrecisionFormat();
            obj.rangeMin = 31;
            obj.rangeMax = 30;
            obj.precision = 0;
            return obj
        }
        if (arguments[0] === 35633 && arguments[1] === 36340) {
            obj = new WebGLShaderPrecisionFormat();
            obj.rangeMin = 31;
            obj.rangeMax = 30;
            obj.precision = 0;
            return obj
        }
        if (arguments[0] === 35633 && arguments[1] === 36339) {
            obj = new WebGLShaderPrecisionFormat();
            obj.rangeMin = 31;
            obj.rangeMax = 30;
            obj.precision = 0;
            return obj
        }
        if (arguments[0] === 35632 && arguments[1] === 36341) {
            obj = new WebGLShaderPrecisionFormat();
            obj.rangeMin = 31;
            obj.rangeMax = 30;
            obj.precision = 0;
            return obj
        }
        if (arguments[0] === 35632 && arguments[1] === 36340) {
            obj = new WebGLShaderPrecisionFormat();
            obj.rangeMin = 31;
            obj.rangeMax = 30;
            obj.precision = 0;
            return obj
        }
        if (arguments[0] === 35632 && arguments[1] === 36339) {
            obj = new WebGLShaderPrecisionFormat();
            obj.rangeMin = 31;
            obj.rangeMax = 30;
            obj.precision = 0;
            return obj
        }
    },
    readPixels: function readPixels() {
        // AsObj.print("readPixels:", arguments);
    },
    RGBA: 6408,
    UNSIGNED_BYTE:5121
};
webgl.__proto__ = WebGLRenderingContext.prototype;;
safeFunction(webgl.canvas.toDataURL);
webgl.__proto__ = WebGLRenderingContext.prototype;
safeFunction(webgl.getParameter)
safeFunction(webgl.getExtension)

createTagProto('CanvasRenderingContext2D');
canvas2d = {
    moveTo:function moveTo(){},
    stroke:function stroke(){},
    lineTo:function lineTo(){},
    canvas: this,
    direction: "ltr",
    fillStyle: "#000000",
    filter: "none",
    font: "24px Arial",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    lineCap: "butt",
    lineDashOffset: 0,
    lineJoin: "miter",
    lineWidth: 1,
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: "#000000",
    textAlign: "start",
    textBaseline: "alphabetic",
    fillRect: function fillRect(v1, v2, v3, v4) {},
    fillText: function fillText(v1, v2, v3) { },
    rect: function rect(v1, v2, v3, v4) { },
    isPointInPath: function isPointInPath() {
        if (arguments[0] === 6 && arguments[1] === 6 && arguments[2] === "evenodd") {
            return false;
        }
    },
    beginPath: function () { },
    closePath: function () { },
    strokeRect: function (v1, v2, v3, v4) { },
    strokeText: function (v1, v2, v3) { },
    clearRect: function (v1, v2, v3, v4) { },
    fill: function () { },
    fillStyle: function (v1) { },
    arc: function (v1, v2, v3, v4, v5, v6) { },
    getImageData: function getImageData() {
        return watch({width: 100, height: 100},'ImageData')
    },
    putImageData: function () { },
    createImageData: function createImageData() {
        return watch({
            data:{set:function(v1,v2,v3,v4){}}
        },'ImageData')
    },
    measureText: function measureText() {
        AsObj.print("measureText:", arguments[0]);
        return {
            "width": 396,
            "actualBoundingBoxLeft": 0,
            "actualBoundingBoxRight": 389,
            "fontBoundingBoxAscent": 62,
            "fontBoundingBoxDescent": 10,
            "actualBoundingBoxAscent": 51,
            "actualBoundingBoxDescent": -1,
            "hangingBaseline": 49.599998474121094,
            "alphabeticBaseline": 0,
            "ideographicBaseline": -10
        }
    }
};
canvas2d.__proto__ = CanvasRenderingContext2D.prototype;

njumber = 0
todataurl_list = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAYAAABYfzddAAAAAXNSR0IArs4c6QAAGq1JREFUeF7tnQuUVMWZx3/3dve8EIY3DAMDOCKoCwgSMUo2ml1xo56sq9EobAxBRDBHXaNx3XN0JWJiNtEYMVEYEdFNzEaiMSeo0URNDkRFEUIQ5SECw2NAhsfw6Hl0973rV7er5/ad29MPGBjMrXM8R+beqlv1Vf3r+77/91W1QVACCQQSOGElYJywPf+Mdtyejn0shxaNw1u7YNUeGNEdzusP5UXHsgfOt4wagrVYgNgDoRUgtI6scqwAvLgWvr8S3tkNA/oUU9mniF17Y9TuauLMHnDrKJh0CscMVQGAC1tVAYALk1uH1epoADcn4OrX4M97w/zwW0O5ZmIfupSGUuNpbrF4/k/13P7IJqpDLSz+F+h2DDRyAODCllTnB/ANcy/HNp5LDu8FoBrTmsbcme8UNmRXLaftW4mHL1Z/DcdfwrBfYd6M+464bWlg6hNd820zE4C3053zuIMfs4jLWVlQ98Q2v/T3EO1dzi9nj6B/r8zIbDgUZ+p969ny/h6WfAVKwwV9MudKAYBzFlXai/4Avr7mGQz7muSbDZjWRCzzCkxrDnNnbi/sUwXUmvHY2SRC95AIXU0kdiG2sUD15eiBVzaGpVB2FUSfBSZg2HcfFQBr8ObZph+AD1LCxdzEUk7hOeYWDODH18JPtpbx3sIxlBSbWSfEtm2+OPNvXGAe4Lvjsr5+RC8EAC5MfOkAnvFYJZb5F2Cr0koLrjuY0iIw8qiBJ9e+3jD3LizzdB6fPinXKnm993ekgeMWDH4GfvuzMxl3Wlclpsn3rGXm5RVMGF2eEtvazVG+89NNPHvfCEpLQmzd1cyor73L5qvtDiW3AgDntXJTL7cCuFVjkAKvu80b5t6EYS87Ktov176KJSAlADBHakL/fit8b0c3lswbrUQabUrQ5fw3uWdaFbOmDU7NyILf7eS6721gzS/HcvrQLurvV9/1IV9qrmf6ablOXP7vBQDOX2ZSoxXAYq5a5qsY9gMZTchWDS0zvhS4Hvg94PxbtLZj6j6HbfwS0/oA27gI2/guhv1r1UUxgW1jYNKvdcxzr0mc/h1nZIZ9BYa9DctchGldmaojWto2ZieHvwXTOk+Z+a1tiGk8HVid7N8tyfe3YNgPYhtXpfnA8BbweWVOQ2t76b649McxtfV3DPvbWOZXk66HIwspbr+61TVpbdc9bzMeO7vcal7WQGnqr+U08io/oZL9KR/4Ayq4m39V71zDuzzDfJ5nDFcwgwl8xEs8Qlea0lbEHcugeOwgZt8wJG8AP/7bOl579iP+758KW2S51AoAnIuU2r7TCmC9QAUo82Y8n7G5VmLmodR7bk0pzyOxKUC5C1jOgg4l5qkFLuAWrZpNw7qftwKyewr0bhNYzH0HIOcSSlxBIiT+bevGIs+d93+sQC7F7S5osGlXoaXoQwU+29hKInRDEojOmJ1NY5rnO3qTWabaFUDHIn9IAdiwn8QyX85IwCXl+hxzJwhJJYCcyjcUeM9mcxsNLM+/zZX8hR8qcIufvJDPcxNv+E7dpNfhwquH8c1L+ztDt2wm3vI+//n1gVx4do9UnZXrDnHrwx8rE7pvT4fk+uM7+/ju999XZFZHlQDAhUnWDWBHk2UDsHzHC1hZ6DAoCYxKbGM882Y8klzoF6VMcmfhZ/63dwxegDtWgqOBNcAMu3UjcWtDMfc1kAR0fhtPNh/YDXg3eee3EQhg5TvuPmgA28YBDFvk8+WMJKBT7+Vl3D9SA/bL3Mx8nvYFsCa2LmINd/GSAryUTAz1dX+Gs75SzY1XDMh7pfxuyR4eefgDXnVsig4pAYALE2v+Gli+417AidBpmFY3pdlkEUNlylfOBljv83wADNvTACp13WEbR+M5mtALLG1hZAOws2HMTwHPzSxr81pr8vYA7JjjjoZuz7q5vuaZ2cYL1wgg32EI07iWl5mjNKyfDyygfYh/VibzfVzMzbyu3vUr9/8V6gYPYM5t1erxa+/uZ8mqhoyrZmR1F664oLd6/qOfb2Pz65v4mTOKDikBgAsTaz4k1uXqE14wCGBjkYXKPJZiWm+pfzsma/sa90gA7DZxNcnl1rJeDezWjLkC2A1wx/y/2OXDp5vi7QFYYssgfIBTJ1MozuMDu0NGfgDWf7uNP7CNHvwPmT2f5bth0vJS1i9y4kFPLt7JP055mepqB9DucvjwYR66fQx3TXHM7QtvWs3M7vu5fGhhiyyXWgGAc5FS23e8YSSHyNKEj4BQiixkIWjcbLDjbw4C5lNzw1NJrfxcWhy1IwEsxJcmsLRmcwOuqKVbGw2tfWQBUUvRAeWfOtqxNRYsPq+MM30zSCfPtAUifjDxGEboKV9N7/aBhfDSMtMhOvd8yPdCiXnbjDuu8dOimVho0bwPMDHlK7e3DM56Hm67aTiTLurLoWiCk694l937Ym2qlJWYrP3VOAb1K2bpqga+duvf2DIJwtlDx4WtwiAXunC5tanpxwBr0sn9stc/9Gq4dHZYGGthd7+TbKLtv92Lum0fHLZaSi4stPOexLOd+IgGeLoJLPZjjWKc28a825q86ckttYqkM4x1YFVgG7KRyXduxjZuS30X40OwneCLsNYS09YJMl5zOr1vKUkLy/wjfq0Y6C30Un/3aubv8FXm8fM2zLN3buXAwkWvhXlrwRiGDijhg02HufS2D5gcDnF9/zJe3NvMPXsa+c0PTuO80eXsOxDjzGtXUjO2mYsGFrzGcqoYaOCcxNTmpc6fSunuspvEOhrZWIXJrGNqJdl7254xx/2BP3Ia3WhURJZfEV95GUMzss/eOj9dA99fV8TCu09l4vgeHDgc5+mXPqG+IUa3shBf/3Jf+vQo4p01B/n3Weu4rGcjPxzfMUN2txoAuDAZn3gA1qmV2rwvbNydr1Yy68w2pusUVhUams0l3M2LGbXrDCYzlb9kBLjfQB95H/7zHfjK+b2Zckk/vjimXGVdxeIWS1cd4Fd/3M2Tv9vJHaPg3nHH5kRSAODClmTnB7Af83ss87ELk2v+tXxMaJ3E4dW+onUn8h9IwkehudG7GkGA/Np2eHc3JGwHqGf2hi8NgG+dAUOdjMtjUgIAFybmzg/gwsZ1wtbq6OOEnVUwAYALm5kAwIXJrcNqBQDuMNF+JhsOANzJpjUAcCebkE7enQDAnXyCgu4FEmhPAgGAg/URSOAElkAA4BN48oKun3ASkIuJugNlQHHyPzny1QI0J/87DEiSUTyX0QUAzkVKwTuBBI5MAoIzOQbWz30Gv6J3hKqKMmrrotTVp6W0yvVldcBOaP+a4QDARzYxQe1AAtkkINr2ZNG2vcsjTLusgksmlDOyuozyskiqbkNDjNUbo7ywtJ6nXqxXmXFAI/AxeG5ncH0xAHA28QfPAwkULoG+nx72GRiJYNw5qYo7v1FFmcA5S2mIxpg9v5Y5i+qIxZQGljzavX7VAgBnk2bwPJBAYRIQk7liRFUZix8YQXVVDsj1fEc08qW3rKbWMa+3Abu8XckJwDe+wUnxrvQzTE5K2Kgbgk0buwViJWH29t/HrlkX5OZ0FyaLY1TLxrjxfQbGGullh1C3nZs2hxMtxI1iyuX/a8ax9hj1xvcz05czwjLoQpy988ezSV6aJqcZwvTsDP3z6/SNa+jf0kTl8erfcZBPT2BodUUZby8ciZjOhRbxjc+askL7yB8lCa5Uc+0CePpyIkaIIQmLbrqGYZIgBlYRhpFAnRC1DOLFYWofG8W+QjvaGerN+CuV8QTqFLttYckmZYU4ZMRJdBaABADOf6UcYwCLgvuHsjJCbz8+Vvm6R1qWrW7gCzeuFnNaVPH7ArkUHjM1PmsNRdsPM8wOUSKL2Uiwe+B4dswyWivPXEKPRCkDLYMiK0685CQ2PnoGh460w8ervp5oI87Bx8ez/nj1o73vBgDOf1aOMYDl5HS/Z+8fwZXJK4l0jwWIvXtHEM2cqWysjdIQhbEj0t+Z/0Id1/9go1TbkWSoVRMZNfD05VRbBt0FmM02m35xDgf8Pjp9OWWWwSlAREykAWex3g3y/MV9/GroiXabp8evN/5fDgCc/4wcQwCL2zV6wshyY8njI9M6+uLSBi69fTXl5RF2Lx5PxMeqFiZ6wKXLiMZA6k8Y2XrhvjQ2avIKYaoTwCodXvIF8NSldA0VUa38wBi75p+jHOiMRUzPhE0fWoiW7GFLc1/6WQZ9QiYH5o1hg7vidW/SkzIGi/lt2uyuGYfcbpEq1y/jVDtMV/1ML9iiErZHW2gKxRlomCoILiUWDrNz7mg+EXM/YTAYi66GiSlWg11MQ9UearP55yngekYYMojbFhusBP0ymdBXrqGo/BCVoQjdND8g9eKwf1AD273f1uOxDOrClroAWs2SZdDYtZnND51LIzbG1JVUmDZyq5xsjLY8N222AFXt+cDhUrY1NlMVsSixDLVBxyyD+gVjqMNoG1OcvpxyO0w/bMpsK+X32zGTpkSMXU+PZ49bLN75KLYZYCe/ZSRIWGH2ecedyQcWK29bE3IpV5lp09IY4eP/HY0kMrRfPPKRl+0wzaEYO8OlhL3+thfAUzZREt7LqUnZ7qgZp2KuaeXrq+hSluCUeAIzEWbTwjEZbgtMr6Z838fvrFbhInd5bFEdNz6oNCg7Fo9HYsDesnZjlNMmr1B/Xnj3CL5xiXOpoC4PPlPH7XNUGylf2BfA05erRdJHFmI0xEc5CdX1IQ3SUJx4cTnrHxmmskxU0W3L/1sWhxZ8jnX6mRasLCQtNL1gRLsnM1iUfyoglQUqiztusjNk0sNOUCI+uhXHkOfSrhHiYOVoPmrPKpA+2RY9tV9vh7DMFgWaeLcYGw+G6O8H4Jl/o0e8icGa8FL8gOM/65/7ixWV8LHbrXCNp0VcD91fK0Tz4AbWcz5W7XKGmSYnJduyzDC2tCnWkBXCChsU+ZFY0t+QgSHveuUgsq4axwa3HKauYEDYor+Wo8iVSGv/tWwXjFVmm54/RaLp+ZC63m/JDz8MPMAGvXn5AXjWG4RrT6JaxpkPeGfZmNtXcYqdQJ1WVlxFUj7SX/m27p8mHP00cMrCDHNowejWNegaZ4VlMCBk0LiugfV/yo2klVvze235zXiqKtIBejQALKy0aGHgE/XzR5lM6KnvMjy5gKIDx7IuX5NYdtbNjQwPhQkTZcsT57bGsFImoMPwtrgBPn250jhVCZuWkMG6mnHEPO8f3lfKx4vOoEUWwLZuDFO7dxg7niBRfJjax77gEGliFVgG/WSCE4fZuGACzgV97ZRMJrTfApjyBiVFXRmmQBiiqclgs97oblzDSfFGhupnRpz1MpbkBuYAIIxt2uyaeybqx+KufJbQoqtI6A0uyTvsmH+OEzpwt6mG4MNCJ4cWi0TZquUw7W362SEGyIbmtni0lWUUYxKjvuYstmoNLWMzyjk5ZFMqY/Prv3xLQKznQ/597ZtUlhTRTzYBE7aJZZTsexoLLSB0bVJtNrl25+htBhJx5tVIkJKPaMyiFoZq68zNeGcAcO8YVBWZJLxKSvq34z1OlXkKh9ip5yjb+gFOr+odKd2yuO0dREcDwPL9Ll9YKia28ExK8bXRwOe/QXh4OacmbEr9TOAcBqF3auVDuxeN1rCiIcUHEPMkZPBxzTiV+5kKh1gR9i0YpTJQRGM7YROIde3LhocGqewUVaa8Q/9wiEoBg2Wyff7I1jiZ/pYZVpcpphbT0QKwZqxF65U0sPHRC9LJu8lv062smJOVpeDqmx6PbdGsNyndJ73xKQ3r47pMWUn3UFwtUtMPwGI5eDdMJdfkoo/btAwpZd2sM2iZvpwKO0Q/2UQrPtX8Pqa+2kxFu4obUTOOaLb5kIW/bQXDZVONm+xZOMa5yMutgYUj0Ro0X+Izm3y0zMUCyQHAkYTNcAG8F6R6c5O+J1py2/yTc3jmBWPLQ68/mu7/yrNnXq1n8n+vVb7v/lcm+CZ0SMhIfGApEju+ZEK6CS1/l5DSirVRsWiFjW4LYOVLJgd2JGTOjFX0tWCgFadRa/Frl9ErUkxV2OaQnSCUNHWUD6I3DvGnPr2ivbZmHPXuBeMXQ9Smelj8XdciS9ZLjUP850fPUHml7ZZ8NLDLFN5fMw7HufGUG1YyTEJw7o0w5QN73AepKiZ5SzNDxBRsKmaD13VxAySDBva1mEQ7lTQra8EoKmZzLuG+TLJtr/8yhpT15rIQ3AC2IjQTp2e+4HXLJxzCyuTauTiUVMw+E4l13QoGGza9veRranPOYF63s4jGXjKhtyHg8xYhph58qlYldEya2BaY+n1hmyWN8rZJVb5El4STlq5okIMOQmS1BbB7kRyJBr51K6UHP2GY+GRa2No8FAJHzMuwRS/TRgFAyJSErTRWIt6T9QuHOvmffqyrHuzxArB7k2tvc3BxCSk/qr3xaIvCTzvrMU9bxVABgC+Aw+ydP9pJ7nCXXPp700sU05PiWAldWwxOClmUiibTRF4bDewCqPtbfpugBrD7PZnnGGzOkRxSVXU77clnykqGJNdVVgBri0Y2TK1p9fo3w5R6rbpsCkCuFMukgXOom9MrSQ0sp5dW+wJY/qg1hyIjCvCBdU+mrmJ4GLqICdt/FPViXomGFbPZjFAsGtq2aRYfy4or36mfd9M4kQHst+DaG08uC9QPINnCX5kALJo50sLAsEGXJGOdWkRJ5ts42gAWl0MsJtnA811fucjHjzDLpIHd7qI2ozMpkpzQBWdUVURKhMTqqNLlS0uJRhWhqzICM7HQmoHLiYWWhVAaUycuYvEmtmvCSJsiomVberFdqHshH8T3a4xQJGaddCJymI+aelJpxhUjmUbrn8gAdjHuqY0wVw18oIz1QtZ5F0K7AM5BA8cTbF94NjuFFGs6RLVwBOI7W03KJ5cQVrSrxYED5ZQSY7DXPWmv/9LX9jSwzimIFGNGYIhi63MIU2oZ5AJgLfNsPrBu07VGVQ7DjvdUYlIfbRnmCUTBQI/9r4xX8V5dlq2Ocs71Tngon/Lhs2ORXGpdautiDP435SOLeykhRX8A5xsH1iRJEpwpUkq104VqmbiETX2RyQAJ60hsOOXzhigRNjaeoJfb3Nad7owAlr6JdZHccDL6wNof8/OB/fgFvfsLKZeJOS8kkcM1DykfWFtZwjJXRtggxJZ7caX4Cg+/cCQAdoNqxkqGxC16KRKwOLcMPrfLlMkH1uPKFcApwiqChAk2S1y7xaIk4uJh8gCdnD4a9It7R6T5uZKgcensCEuWLMm5qbPOGsXbD5en+cEuJlvIQRWfz5iJpXfSbJlY7p3ca/5qkMYTFNtFRL0aVsfikqGKYklW8JrsnRXAubLQSUY0ZVW0Nx4JjW3vwnCVvmpQ/8RYZ5fVxc2y+vnA4ldGm/nYmzXnCk0p5lvay0ZU6rk5mia0G1TCKG+NcqqwwH4xar+Vno2FlkM3TeVUmzbhXAHs3ozDJnsSONmH3ghBjsgTtTtqwthylniY6HOmrObeh58l4peC5Wk8Go0yZ/ZkXnk4nc1OZmJJrFsILJVzkBHAKhc6xjBJjvDNhbYxpi2jr2GqcIRKMvDLhdZMn3zMq6E1aZPqv4851VkBfKRx4EwMv4R35BhaIowdirNTZwl545yZ4sBC8LQUsUkz2NJeIkz/UFzNdZ1uT1sQEloqgo0ukipiRRhoxughfnFHAVjm/Jsr6IPFoKSxmepbe2BxW3veOHCJzRBZr1I/HwBPW00/06Iy0YKtsvh8Ns8cASyvSWZZ99/cP4LLXLnQOoyUazuLHxipDv7rIof8p8xWbq9o3tTv7LR7GkkWabgb8qOSKUNcn0bSmVAKmGGaW2hdNO5OulMnveyhNu1ES3nB3dlNaOnfkWRitReic6d2qqww28nEUjuuE5cN+QE4IemWCYplbtpkR4l/PIrNOllDmcimivM6GWueLDIjQZP4xxKrd4eejpYJrefXRZjGujazQaWStlOyZWKJSS60Sj7HLd2plSrxJ/fUSb+eygZyekXviCE+rPvWDUmDlHRIKSPLIkySgw1lETZGYzxVH2OtxJo+3XzunVbF3dOqUm1LfFhSLBsaYqJ9Jf6bcneynwe2Maa/p34Wr7ckd+gJTy6q5hjsWfg5dvnl2UoPbtpAcXODymop8mGYU7FaWTCVh1mXKXfYb8EfrzCSe9YkF7pHI4PcZ6WFzBMSZMBBduQzHne7op3MEP2MeHredxx1Ftg/jBRnb7yIfe58cdlcrQS7nhzLbu9qkzCKO5dZ5lTnQJ98Nvt0UoZbIx1tAItlURxXWiuSc9jSLxfaojkRZltRQvnV3fMBsMjF5TLkkzqZaaupBPpPHF/exgxe9Gq9OlV0f0WZArGcNtwYhaUNUR5siKkcaLfmjcVQRwnlJBPyo/bOPVmpkh3Auer8z/B7x/A0y2dYisdmaHqDcWeC5fJlDeA8UyczNS24kp+27XXZhN7I0UK361tfH2POC3WSkJGqf8HYcmZeWZF2+D8ahav+azUvLlPvyQacdvBHWU65DO7v/Z0AwJ1jBejkIOlN3KTWmwSieQkiRHJNn5W2/JKOjtKI1dlgCQU9emc1AtJcy4tL67nlwVo21qkM1rQzwIEGzlWKyfd0OIgMcdY8mwteL1AC7sQLYa7DTh69PiQSiducLIdw3DnfmT41a5bj+/NFzB1dGZzM288YEiywy1JNXWwnylJym2++skIB2Y+MFnP5xWX1zHmmjjcc7Sw3b0gkwvdCu0ADtzMrkr0kFxVImEMdb7SxC4wNHsHcB1W9EnCTb0keJu0IpCLviqh94ozMi17adJOrCikde6OMnF+XS+7kvDBym+wIz7Wykv+8tjYq1+ZIEbJKQCuat00yT6CBc8DFrW9SerBYZYpFZFE0N7L76XOdo39BOb4SUIczmqikqPUSAgVci0MHSqj1y2Dz9thzk0xLqJFt+ghmB47O+8sMwlhLFM37ywz7dZw3W18CHzibhILngQQ6sQQCAHfiyQm6FkggmwQCAGeTUPA8kEAnlkAA4E48OUHXAglkk0AA4GwSCp4HEujEEggA3IknJ+haIIFsEggAnE1CwfNAAp1YAgGAO/HkBF0LJJBNAgGAs0koeB5IoBNLIABwJ56coGuBBLJJ4P8Bygc+POCYw9QAAAAASUVORK5CYII=',
    'data:image/png;base64,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',
    'data:image/png;base64,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'
]
createTagProto('HTMLCanvasElement',['getContext','toDataURL']);
canvas = {
    width: 300,
    height:150,
    __proto__: HTMLCanvasElement.prototype,
    tagName: 'CANVAS',
    getContext: function getContext() {
        AsObj.print('canvas.getContext:', arguments)
        if (arguments[0] === 'webgl') {
            return watch(webgl, 'webgl');
        }
        if (arguments[0] === '2d') {
            return watch(canvas2d, '2d');
        }
    },
    toDataURL: function toDataURL() {
        njumber++
        return todataurl_list[njumber-1]
    }
}
safeFunction(canvas.getContext);
safeFunction(canvas.toDataURL);

createTagProto('HTMLScriptElement',['setAttribute'])
script = {
    __proto__: HTMLScriptElement.prototype,
    tagName: 'SCRIPT',
    setAttribute: function setAttribute() {
        AsObj.print('script.setAttribute:', arguments)
        this[arguments[0]] = arguments[1]
    },
}
safeFunction(script.setAttribute)

createTagProto('HTMLDivElement',['appendChild'])
div = {
    __proto__: HTMLDivElement.prototype,
    tagName: 'DIV',
    style:watch({
        __proto__: CSSStyleDeclaration.prototype,
        setProperty:function(key,value){
            this[key] = value
        },
        nodeName:"DIV"
    }, 'style'),
    appendChild: function appendChild() {
        AsObj.print('div.appendChild:', arguments[0]+'')
    }
}
safeFunction(div.appendChild)

scripts = [watch({
    tagName: 'SCRIPT',
    __proto__: HTMLScriptElement.prototype,
    src: 'Script snippet'
}, 'script1'),
watch({
    tagName: 'SCRIPT',
    __proto__: HTMLScriptElement.prototype,
    src: 'https://console.beeize.com/assets/index-1ca43166.js'
}, 'script2')]
// scripts.__proto__ = HTMLCollection.prototype;

createTagProto('DOMStringMap')
createTagProto('HTMLHeadElement',['insertBefore','removeChild'])
createTagProto('HTMLBodyElement',['addEventListener','appendChild','removeChild'])
createTagProto('HTMLHtmlElement',['getAttribute'])
createTagProto('HTMLDocument')
createTagProto('Document',['browsingTopics','requestStorageAccess','requestStorageAccessFor','hasStorageAccess','getElementsByTagName','hasPrivateToken','createElement','hasRedemptionRecord','hasFocus'])
createTagProto('Node')
document = {
    head:watch({
        __proto__: HTMLHeadElement.prototype,
        insertBefore:function insertBefore() {
            AsObj.print('head.insertBefore:', arguments)
            // if (arguments[0].hasOwnProperty('text')) {
            //     eval(arguments[0].text)
            // }
            if (arguments[0].tagName === 'SCRIPT') {
                arguments[0].parentNode = document.head
                scripts.push(arguments[0])
            }
        },
        removeChild:function removeChild() {
            AsObj.print('head.removeChild:', arguments)
        },
    }, 'head'),
    cookie: '_c_WBKFRo=LnUvOq48OfX5tlliC1kdEPVyvRD6rSJogivptMOL; _nb_ioWEgULi=',

    body: watch({
        
        __proto__: HTMLBodyElement.prototype,
        addEventListener: function addEventListener() {
            AsObj.print('body.addEventListener:', arguments)
        },
        appendChild: function appendChild() {
            AsObj.print('body.appendChild:', arguments[0]+'')
        },
        removeChild:function removeChild() {
            AsObj.print('body.removeChild:', arguments[0]+'')
        },
        scrollTop: 0
    },'body'),
    createElement: function createElement() {
        AsObj.print('document.createElement:', arguments)
        if (arguments[0] === 'span') {
            return watch(span, 'span');
        }
        if (arguments[0] === 'iframe') {
            return watch(iframe, 'iframe');
        }
        if (arguments[0] === 'canvas') {
            return watch(canvas, 'canvas');
        }
        if (arguments[0] === 'script') {
            return watch(script, 'script');
        }
        if (arguments[0] === 'div') {
            return watch(div, 'div');
        }
    },
    documentElement: watch({
        __proto__: HTMLHtmlElement.prototype,
        getAttribute:function getAttribute() {
            AsObj.print('documentElement.getAttribute:', arguments)
            return null;
        },
        dataset: watch({
            __proto__: DOMStringMap.prototype,
            hasOwnProperty: function hasOwnProperty() {
                AsObj.print('documentElement.dataset.hasOwnProperty:', arguments)
                if (arguments[0] === 'wgscriptallow') {
                    return false;
                }
            }
        }, 'dataset'),
        clientHeight: 732,
        clientWidth: 145,
        hasFocus:function hasFocus() {
            AsObj.print('documentElement.hasFocus:', arguments)
            return false;
        },
        outerHTML:`<html lang="en"><head><style data-rc-order="prepend" rc-util-key="@ant-design-icons">\n.anticon {\n  display: inline-flex;\n  align-items: center;\n  color: inherit;\n  font-style: normal;\n  line-height: 0;\n  text-align: center;\n  text-transform: none;\n  vertical-align: -0.125em;\n  text-rendering: optimizeLegibility;\n  -webkit-font-smoothing: antialiased;\n  -moz-osx-font-smoothing: grayscale;\n}\n\n.anticon > * {\n  line-height: 1;\n}\n\n.anticon svg {\n  display: inline-block;\n}\n\n.anticon::before {\n  display: none;\n}\n\n.anticon .anticon-icon {\n  display: block;\n}\n\n.anticon[tabindex] {\n  cursor: pointer;\n}\n\n.anticon-spin::before,\n.anticon-spin {\n  display: inline-block;\n  -webkit-animation: loadingCircle 1s infinite linear;\n  animation: loadingCircle 1s infinite linear;\n}\n\n@-webkit-keyframes loadingCircle {\n  100% {\n    -webkit-transform: rotate(360deg);\n    transform: rotate(360deg);\n  }\n}\n\n@keyframes loadingCircle {\n  100% {\n    -webkit-transform: rotate(360deg);\n    transform: rotate(360deg);\n  }\n}\n</style><style data-rc-order="prependQueue" data-rc-priority="-999" data-css-hash="n4wmgf" data-token-hash="gxfx27">:where(.css-9kmff0) a{color:#1677ff;text-decoration:none;background-color:transparent;outline:none;cursor:pointer;transition:color 0.3s;-webkit-text-decoration-skip:objects;}:where(.css-9kmff0) a:hover{color:#69b1ff;}:where(.css-9kmff0) a:active{color:#0958d9;}:where(.css-9kmff0) a:active,:where(.css-9kmff0) a:hover{text-decoration:none;outline:0;}:where(.css-9kmff0) a:focus{text-decoration:none;outline:0;}:where(.css-9kmff0) a[disabled]{color:rgba(0, 0, 0, 0.25);cursor:not-allowed;}</style><style data-rc-order="prependQueue" data-rc-priority="-999" data-css-hash="1ul9uxr" data-token-hash="gxfx27">:where(.css-9kmff0)[class^="ant-tabs"],:where(.css-9kmff0)[class*=" ant-tabs"]{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif,'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol','Noto Color Emoji';font-size:14px;box-sizing:border-box;}:where(.css-9kmff0)[class^="ant-tabs"]::before,:where(.css-9kmff0)[class*=" ant-tabs"]::before,:where(.css-9kmff0)[class^="ant-tabs"]::after,:where(.css-9kmff0)[class*=" ant-tabs"]::after{box-sizing:border-box;}:where(.css-9kmff0)[class^="ant-tabs"] [class^="ant-tabs"],:where(.css-9kmff0)[class*=" ant-tabs"] [class^="ant-tabs"],:where(.css-9kmff0)[class^="ant-tabs"] [class*=" ant-tabs"],:where(.css-9kmff0)[class*=" ant-tabs"] [class*=" ant-tabs"]{box-sizing:border-box;}:where(.css-9kmff0)[class^="ant-tabs"] [class^="ant-tabs"]::before,:where(.css-9kmff0)[class*=" ant-tabs"] [class^="ant-tabs"]::before,:where(.css-9kmff0)[class^="ant-tabs"] [class*=" ant-tabs"]::before,:where(.css-9kmff0)[class*=" ant-tabs"] [class*=" ant-tabs"]::before,:where(.css-9kmff0)[class^="ant-tabs"] [class^="ant-tabs"]::after,:where(.css-9kmff0)[class*=" ant-tabs"] [class^="ant-tabs"]::after,:where(.css-9kmff0)[class^="ant-tabs"] [class*=" ant-tabs"]::after,:where(.css-9kmff0)[class*=" ant-tabs"] [class*=" ant-tabs"]::after{box-sizing:border-box;}:where(.css-9kmff0).ant-tabs-small >.ant-tabs-nav .ant-tabs-tab{padding:8px 0;font-size:14px;}:where(.css-9kmff0).ant-tabs-large >.ant-tabs-nav .ant-tabs-tab{padding:16px 0;font-size:16px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-small >.ant-tabs-nav .ant-tabs-tab{padding:6px 16px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-small.ant-tabs-bottom >.ant-tabs-nav .ant-tabs-tab{border-radius:0 0 6px 6px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-small.ant-tabs-top >.ant-tabs-nav .ant-tabs-tab{border-radius:6px 6px 0 0;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-small.ant-tabs-right >.ant-tabs-nav .ant-tabs-tab{border-radius:0 6px 6px 0;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-small.ant-tabs-left >.ant-tabs-nav .ant-tabs-tab{border-radius:6px 0 0 6px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-large >.ant-tabs-nav .ant-tabs-tab{padding:8px 16px 6px;}:where(.css-9kmff0).ant-tabs-rtl{direction:rtl;}:where(.css-9kmff0).ant-tabs-rtl .ant-tabs-nav .ant-tabs-tab{margin:0 0 0 32px;}:where(.css-9kmff0).ant-tabs-rtl .ant-tabs-nav .ant-tabs-tab .ant-tabs-tab:last-of-type{margin-left:0;}:where(.css-9kmff0).ant-tabs-rtl .ant-tabs-nav .ant-tabs-tab .anticon{margin-right:0;margin-left:12px;}:where(.css-9kmff0).ant-tabs-rtl .ant-tabs-nav .ant-tabs-tab .ant-tabs-tab-remove{margin-right:8px;margin-left:-4px;}:where(.css-9kmff0).ant-tabs-rtl .ant-tabs-nav .ant-tabs-tab .ant-tabs-tab-remove .anticon{margin:0;}:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-left >.ant-tabs-nav{order:1;}:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-left >.ant-tabs-content-holder{order:0;}:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-right >.ant-tabs-nav{order:0;}:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-right >.ant-tabs-content-holder{order:1;}:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-card.ant-tabs-top >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-card.ant-tabs-bottom >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-card.ant-tabs-top >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-rtl.ant-tabs-card.ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab{margin-right:2px;margin-left:0;}:where(.css-9kmff0).ant-tabs-dropdown-rtl{direction:rtl;}:where(.css-9kmff0).ant-tabs-menu-item .ant-tabs-dropdown-rtl{text-align:right;}:where(.css-9kmff0).ant-tabs-top,:where(.css-9kmff0).ant-tabs-bottom{flex-direction:column;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav{margin:0 0 16px 0;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav::before,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav::before,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav::before,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav::before{position:absolute;right:0;left:0;border-bottom:1px solid #f0f0f0;content:'';}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-ink-bar{height:2px;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-ink-bar-animated,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-ink-bar-animated,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-ink-bar-animated,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-ink-bar-animated{transition:width 0.3s,left 0.3s,right 0.3s;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-nav-wrap::after{top:0;bottom:0;width:32px;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-nav-wrap::before{left:0;box-shadow:inset 10px 0 8px -8px rgba(0, 0, 0, 0.08);}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-nav-wrap::after{right:0;box-shadow:inset -10px 0 8px -8px rgba(0, 0, 0, 0.08);}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-left::before,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-left::before,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-left::before,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-left::before{opacity:1;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-right::after,:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-right::after,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-right::after,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-right::after{opacity:1;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav::before,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav::before{bottom:0;}:where(.css-9kmff0).ant-tabs-top >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-top >div>.ant-tabs-nav .ant-tabs-ink-bar{bottom:0;}:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav{order:1;margin-top:16px;margin-bottom:0;}:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav::before,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav::before{top:0;}:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-ink-bar{top:0;}:where(.css-9kmff0).ant-tabs-bottom >.ant-tabs-content-holder,:where(.css-9kmff0).ant-tabs-bottom >div>.ant-tabs-content-holder{order:0;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav{flex-direction:column;min-width:40px;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-tab{padding:8px 24px;text-align:center;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab{margin:16px 0 0 0;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap{flex-direction:column;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap::after{right:0;left:0;height:32px;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap::before{top:0;box-shadow:inset 0 10px 8px -8px rgba(0, 0, 0, 0.08);}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap::after{bottom:0;box-shadow:inset 0 -10px 8px -8px rgba(0, 0, 0, 0.08);}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-top::before,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-top::before,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-top::before,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-top::before{opacity:1;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-bottom::after,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-bottom::after,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-bottom::after,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-wrap.ant-tabs-nav-wrap-ping-bottom::after{opacity:1;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-ink-bar{width:2px;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-ink-bar-animated,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-ink-bar-animated,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-ink-bar-animated,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-ink-bar-animated{transition:height 0.3s,top 0.3s;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-list,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-list,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-list,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-list,:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-nav-operations,:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-nav-operations,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-nav-operations,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-nav-operations{flex:1 0 auto;flex-direction:column;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-nav .ant-tabs-ink-bar{right:0;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-content-holder,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-content-holder{margin-left:-1px;border-left:1px solid #d9d9d9;}:where(.css-9kmff0).ant-tabs-left >.ant-tabs-content-holder >.ant-tabs-content>.ant-tabs-tabpane,:where(.css-9kmff0).ant-tabs-left >div>.ant-tabs-content-holder >.ant-tabs-content>.ant-tabs-tabpane{padding-left:24px;}:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav{order:1;}:where(.css-9kmff0).ant-tabs-right >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-nav .ant-tabs-ink-bar{left:0;}:where(.css-9kmff0).ant-tabs-right >.ant-tabs-content-holder,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-content-holder{order:0;margin-right:-1px;border-right:1px solid #d9d9d9;}:where(.css-9kmff0).ant-tabs-right >.ant-tabs-content-holder >.ant-tabs-content>.ant-tabs-tabpane,:where(.css-9kmff0).ant-tabs-right >div>.ant-tabs-content-holder >.ant-tabs-content>.ant-tabs-tabpane{padding-right:24px;}:where(.css-9kmff0).ant-tabs-dropdown{box-sizing:border-box;margin:0;padding:0;color:rgba(0, 0, 0, 0.88);font-size:14px;line-height:1.5714285714285714;list-style:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif,'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol','Noto Color Emoji';position:absolute;top:-9999px;left:-9999px;z-index:1050;display:block;}:where(.css-9kmff0).ant-tabs-dropdown-hidden{display:none;}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu{max-height:200px;margin:0;padding:4px 0;overflow-x:hidden;overflow-y:auto;text-align:left;list-style-type:none;background-color:#ffffff;background-clip:padding-box;border-radius:8px;outline:none;box-shadow:0 6px 16px 0 rgba(0, 0, 0, 0.08),0 3px 6px -4px rgba(0, 0, 0, 0.12),0 9px 28px 8px rgba(0, 0, 0, 0.05);}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;display:flex;align-items:center;min-width:120px;margin:0;padding:4px 12px;color:rgba(0, 0, 0, 0.88);font-weight:normal;font-size:14px;line-height:1.5714285714285714;cursor:pointer;transition:all 0.3s;}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item >span{flex:1;white-space:nowrap;}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item-remove{flex:none;margin-left:12px;color:rgba(0, 0, 0, 0.45);font-size:12px;background:transparent;border:0;cursor:pointer;}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item-remove:hover{color:#4096ff;}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item:hover{background:rgba(0, 0, 0, 0.04);}:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item-disabled,:where(.css-9kmff0).ant-tabs-dropdown .ant-tabs-dropdown-menu-item-disabled:hover{color:rgba(0, 0, 0, 0.25);background:transparent;cursor:not-allowed;}:where(.css-9kmff0).ant-tabs-card >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card >div>.ant-tabs-nav .ant-tabs-tab{margin:0;padding:8px 16px;background:rgba(0, 0, 0, 0.02);border:1px solid #f0f0f0;transition:all 0.3s cubic-bezier(0.645, 0.045, 0.355, 1);}:where(.css-9kmff0).ant-tabs-card >.ant-tabs-nav .ant-tabs-tab-active,:where(.css-9kmff0).ant-tabs-card >div>.ant-tabs-nav .ant-tabs-tab-active{color:black;background:#ffffff;}:where(.css-9kmff0).ant-tabs-card >.ant-tabs-nav .ant-tabs-ink-bar,:where(.css-9kmff0).ant-tabs-card >div>.ant-tabs-nav .ant-tabs-ink-bar{visibility:hidden;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-top >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-bottom >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-top >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab{margin-left:2px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-top >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-top >div>.ant-tabs-nav .ant-tabs-tab{border-radius:8px 8px 0 0;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-top >.ant-tabs-nav .ant-tabs-tab-active,:where(.css-9kmff0).ant-tabs-card.ant-tabs-top >div>.ant-tabs-nav .ant-tabs-tab-active{border-bottom-color:#ffffff;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-bottom >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-tab{border-radius:0 0 8px 8px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-bottom >.ant-tabs-nav .ant-tabs-tab-active,:where(.css-9kmff0).ant-tabs-card.ant-tabs-bottom >div>.ant-tabs-nav .ant-tabs-tab-active{border-top-color:#ffffff;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-left >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-right >.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-left >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-right >div>.ant-tabs-nav .ant-tabs-tab+.ant-tabs-tab{margin-top:2px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-left >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-left >div>.ant-tabs-nav .ant-tabs-tab{border-radius:8px 0 0 8px;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-left >.ant-tabs-nav .ant-tabs-tab-active,:where(.css-9kmff0).ant-tabs-card.ant-tabs-left >div>.ant-tabs-nav .ant-tabs-tab-active{border-right-color:#ffffff;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-right >.ant-tabs-nav .ant-tabs-tab,:where(.css-9kmff0).ant-tabs-card.ant-tabs-right >div>.ant-tabs-nav .ant-tabs-tab{border-radius:0 8px 8px 0;}:where(.css-9kmff0).ant-tabs-card.ant-tabs-right >.ant-tabs-nav .ant-tabs-tab-active,:where(.css-9kmff0).ant-tabs-card.ant-tabs-right >div>.ant-tabs-nav .ant-tabs-tab-active{border-left-color:#ffffff;}:where(.css-9kmff0).ant-tabs{box-sizing:border-box;margin:0;padding:0;color:rgba(0, 0, 0, 0.88);font-size:14px;line-height:1.5714285714285714;list-style:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif,'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol','Noto Color Emoji';display:flex;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav{position:relative;display:flex;flex:none;align-items:center;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-wrap,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-wrap{position:relative;display:flex;flex:auto;align-self:stretch;overflow:hidden;white-space:nowrap;transform:translate(0);}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-wrap::before,:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-wrap::after,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-wrap::after{position:absolute;z-index:1;opacity:0;transition:opacity 0.3s;content:'';pointer-events:none;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-list,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-list{position:relative;display:flex;transition:opacity 0.3s;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-operations,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-operations{display:flex;align-self:stretch;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-operations-hidden,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-operations-hidden{position:absolute;visibility:hidden;pointer-events:none;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-more,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-more{position:relative;padding:8px 16px;background:transparent;border:0;color:rgba(0, 0, 0, 0.88);}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-more::after,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-more::after{position:absolute;right:0;bottom:0;left:0;height:5px;transform:translateY(100%);content:'';}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-add,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-add{min-width:40px;min-height:40px;margin-left:2px;padding:0 8px;background:transparent;border:1px solid #f0f0f0;border-radius:8px 8px 0 0;outline:none;cursor:pointer;color:rgba(0, 0, 0, 0.88);transition:all 0.3s cubic-bezier(0.645, 0.045, 0.355, 1);}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-add:hover,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-add:hover{color:#4096ff;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-add:active,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-add:active,:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-add:focus:not(:focus-visible),:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-add:focus:not(:focus-visible){color:#0958d9;}:where(.css-9kmff0).ant-tabs >.ant-tabs-nav .ant-tabs-nav-add:focus-visible,:where(.css-9kmff0).ant-tabs >div>.ant-tabs-nav .ant-tabs-nav-add:focus-visible{outline:4px solid #91caff;outline-offset:1px;transition:outline-offset 0s,outline 0s;}:where(.css-9kmff0).ant-tabs .ant-tabs-extra-content{flex:none;}:where(.css-9kmff0).ant-tabs .ant-tabs-ink-bar{position:absolute;background:#1677ff;pointer-events:none;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab{position:relative;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;display:inline-flex;align-items:center;padding:12px 0;font-size:14px;background:transparent;border:0;outline:none;cursor:pointer;color:rgba(0, 0, 0, 0.88);}:where(.css-9kmff0).ant-tabs .ant-tabs-tab-btn:focus:not(:focus-visible),:where(.css-9kmff0).ant-tabs .ant-tabs-tab-remove:focus:not(:focus-visible),:where(.css-9kmff0).ant-tabs .ant-tabs-tab-btn:active,:where(.css-9kmff0).ant-tabs .ant-tabs-tab-remove:active{color:#0958d9;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab-btn:focus-visible,:where(.css-9kmff0).ant-tabs .ant-tabs-tab-remove:focus-visible{outline:4px solid #91caff;outline-offset:1px;transition:outline-offset 0s,outline 0s;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab-btn{outline:none;transition:all 0.3s;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab-btn .ant-tabs-tab-icon:not(:last-child){margin-inline-end:12px;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab-remove{flex:none;margin-right:-4px;margin-left:8px;color:rgba(0, 0, 0, 0.45);font-size:12px;background:transparent;border:none;outline:none;cursor:pointer;transition:all 0.3s;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab-remove:hover{color:rgba(0, 0, 0, 0.88);}:where(.css-9kmff0).ant-tabs .ant-tabs-tab:hover{color:#4096ff;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab.ant-tabs-tab-active .ant-tabs-tab-btn{color:black;text-shadow:0 0 0.25px currentcolor;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab.ant-tabs-tab-disabled{color:rgba(0, 0, 0, 0.25);cursor:not-allowed;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab.ant-tabs-tab-disabled .ant-tabs-tab-btn:focus,:where(.css-9kmff0).ant-tabs .ant-tabs-tab.ant-tabs-tab-disabled .ant-tabs-remove:focus,:where(.css-9kmff0).ant-tabs .ant-tabs-tab.ant-tabs-tab-disabled .ant-tabs-tab-btn:active,:where(.css-9kmff0).ant-tabs .ant-tabs-tab.ant-tabs-tab-disabled .ant-tabs-remove:active{color:rgba(0, 0, 0, 0.25);}:where(.css-9kmff0).ant-tabs .ant-tabs-tab .ant-tabs-tab-remove .anticon{margin:0;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab .anticon:not(:last-child){margin-right:12px;}:where(.css-9kmff0).ant-tabs .ant-tabs-tab+.ant-tabs-tab{margin:0 0 0 32px;}:where(.css-9kmff0).ant-tabs .ant-tabs-content{position:relative;width:100%;}:where(.css-9kmff0).ant-tabs .ant-tabs-content-holder{flex:auto;min-width:0;min-height:0;}:where(.css-9kmff0).ant-tabs .ant-tabs-tabpane{outline:none;}:where(.css-9kmff0).ant-tabs .ant-tabs-tabpane-hidden{display:none;}:where(.css-9kmff0).ant-tabs-centered >.ant-tabs-nav .ant-tabs-nav-wrap:not([class*='.ant-tabs-nav-wrap-ping']),:where(.css-9kmff0).ant-tabs-centered >div>.ant-tabs-nav .ant-tabs-nav-wrap:not([class*='.ant-tabs-nav-wrap-ping']){justify-content:center;}:where(.css-9kmff0).ant-tabs .ant-tabs-switch-appear,:where(.css-9kmff0).ant-tabs .ant-tabs-switch-enter{transition:none;}:where(.css-9kmff0).ant-tabs .ant-tabs-switch-appear-start,:where(.css-9kmff0).ant-tabs .ant-tabs-switch-enter-start{opacity:0;}:where(.css-9kmff0).ant-tabs .ant-tabs-switch-appear-active,:where(.css-9kmff0).ant-tabs .ant-tabs-switch-enter-active{opacity:1;transition:opacity 0.3s;}:where(.css-9kmff0).ant-tabs .ant-tabs-switch-leave{position:absolute;transition:none;inset:0;}:where(.css-9kmff0).ant-tabs .ant-tabs-switch-leave-start{opacity:1;}:where(.css-9kmff0).ant-tabs .ant-tabs-switch-leave-active{opacity:0;transition:opacity 0.3s;}:where(.css-9kmff0).ant-slide-up-enter,:where(.css-9kmff0).ant-slide-up-appear{animation-duration:0.2s;animation-fill-mode:both;animation-play-state:paused;}:where(.css-9kmff0).ant-slide-up-leave{animation-duration:0.2s;animation-fill-mode:both;animation-play-state:paused;}:where(.css-9kmff0).ant-slide-up-enter.ant-slide-up-enter-active,:where(.css-9kmff0).ant-slide-up-appear.ant-slide-up-appear-active{animation-name:css-9kmff0-antSlideUpIn;animation-play-state:running;}:where(.css-9kmff0).ant-slide-up-leave.ant-slide-up-leave-active{animation-name:css-9kmff0-antSlideUpOut;animation-play-state:running;pointer-events:none;}:where(.css-9kmff0).ant-slide-up-enter,:where(.css-9kmff0).ant-slide-up-appear{transform:scale(0);transform-origin:0% 0%;opacity:0;animation-timing-function:cubic-bezier(0.23, 1, 0.32, 1);}:where(.css-9kmff0).ant-slide-up-enter-prepare,:where(.css-9kmff0).ant-slide-up-appear-prepare{transform:scale(1);}:where(.css-9kmff0).ant-slide-up-leave{animation-timing-function:cubic-bezier(0.755, 0.05, 0.855, 0.06);}:where(.css-9kmff0).ant-slide-down-enter,:where(.css-9kmff0).ant-slide-down-appear{animation-duration:0.2s;animation-fill-mode:both;animation-play-state:paused;}:where(.css-9kmff0).ant-slide-down-leave{animation-duration:0.2s;animation-fill-mode:both;animation-play-state:paused;}:where(.css-9kmff0).ant-slide-down-enter.ant-slide-down-enter-active,:where(.css-9kmff0).ant-slide-down-appear.ant-slide-down-appear-active{animation-name:css-9kmff0-antSlideDownIn;animation-play-state:running;}:where(.css-9kmff0).ant-slide-down-leave.ant-slide-down-leave-active{animation-name:css-9kmff0-antSlideDownOut;animation-play-state:running;pointer-events:none;}:where(.css-9kmff0).ant-slide-down-enter,:where(.css-9kmff0).ant-slide-down-appear{transform:scale(0);transform-origin:0% 0%;opacity:0;animation-timing-function:cubic-bezier(0.23, 1, 0.32, 1);}:where(.css-9kmff0).ant-slide-down-enter-prepare,:where(.css-9kmff0).ant-slide-down-appear-prepare{transform:scale(1);}:where(.css-9kmff0).ant-slide-down-leave{animation-timing-function:cubic-bezier(0.755, 0.05, 0.855, 0.06);}</style><style data-rc-order="prependQueue" data-rc-priority="-999" data-css-hash="_effect-css-9kmff0-antSlideUpIn">@keyframes css-9kmff0-antSlideUpIn{0%{transform:scaleY(0.8);transform-origin:0% 0%;opacity:0;}100%{transform:scaleY(1);transform-origin:0% 0%;opacity:1;}}</style><style data-rc-order="prependQueue" data-rc-priority="-999" data-css-hash="_effect-css-9kmff0-antSlideUpOut">@keyframes css-9kmff0-antSlideUpOut{0%{transform:scaleY(1);transform-origin:0% 0%;opacity:1;}100%{transform:scaleY(0.8);transform-origin:0% 0%;opacity:0;}}</style><style data-rc-order="prependQueue" data-rc-priority="-999" data-css-hash="_effect-css-9kmff0-antSlideDownIn">@keyframes css-9kmff0-antSlideDownIn{0%{transform:scaleY(0.8);transform-origin:100% 100%;opacity:0;}100%{transform:scaleY(1);transform-origin:100% 100%;opacity:1;}}</style><style data-rc-order="prependQueue" data-rc-priority="-999" data-css-hash="_effect-css-9kmff0-antSlideDownOut">@keyframes css-9kmff0-antSlideDownOut{0%{transform:scaleY(1);transform-origin:100% 100%;opacity:1;}100%{transform:scaleY(0.8);transform-origin:100% 100%;opacity:0;}}</style><style data-rc-order="prependQueue" data-css-hash="1be4m0s" data-token-hash="gxfx27">.anticon{display:inline-flex;align-items:center;color:inherit;font-style:normal;line-height:0;text-align:center;text-transform:none;vertical-align:-0.125em;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}.anticon >*{line-height:1;}.anticon svg{display:inline-block;}.anticon .anticon .anticon-icon{display:block;}</style><style data-rc-order="prependQueue" data-css-hash="1xzpg85" data-token-hash="7o7r6l">.anticon{display:inline-flex;align-items:center;color:inherit;font-style:normal;line-height:0;text-align:center;text-transform:none;vertical-align:-0.125em;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}.anticon >*{line-height:1;}.anticon svg{display:inline-block;}.anticon .anticon .anticon-icon{display:block;}</style>\n  <meta charset="UTF-8">\n  <link rel="icon" type="image/svg+xml" id="dynamic-favicon" href="/favicon.ico">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title id="dynamic-title">集蜂云</title>\n  \x3Cscript type="text/javascript" src="Script snippet">\x3C/script><style type="text/css">@font-face {font-family: "aliyun-captcha-iconfont";src: url("data:application/font-woff2;base64,d09GMgABAAAAAALkAAsAAAAABsQAAAKWAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHFQGYACCcAqBPIFbATYCJAMICwYABCAFhGcHNBsbBsguIScbXkQAFdTQssL1nfvZdRAAEA9P++M7d2Y+gEQ2KYPpNy9CW0eo1U19I5Q3v8tly9PaeNQqTnVHKyWf21zpydI0kkEJjMNhS1NgcS8c7mDGGbqsy2VfE8ZVW6+51wjbM68AJtNv0/z/v3f8G0Ab5B7Pbc1Fa+MD66RR1gdqrGURdvLQUxFvOehefkWg0ZIxTQdzKzus7ymnnPVr4TQHeWY8jQLOOmSfoiBZL9RSVxbxRQ3pbSp8jj8f/6xEPUlN5uQc38367GnumPy6ek3+5vVyNTgvoQYZc5hCnPfHDjWLNkqzRluLEVQWwU9VFRrEobVC+uuc9GYwDN4z8X3Bo7ImUOjOGubxpF7kgZ6eZ/eY8Zi2082MvV2m799Z8I5rGtvt0OS+ofE94xac7Oxu7O1s7e9t70Lz6wcxjgceOuPsxWNH7IxdbH1mvLT0DBaucVgMDophbHjsqLMYxOFGLX/o3cuQE7AhFo/fDobqdaH85gf/xuoXr20b/+ubCvjeT4aA5qD+DmzB75RfEZHF9JNKG19OJWua71DS6AapOK5Ov1NVXbedCvW6bt5RZyiHrN4IVsgzUKPJCtSqtwmNZs2ub9Kl1CxKAybcMQjtHiFp9RWyds9YIX9DjV5/UKvdPzS6jJbdmkzE9bRCTuhD/RYiUeTSU1KMdwuDy5SrpvAeKh0hCK7lVJPzmKOaY46+CjwiCVIVGcyJ52GaFlCqIkZBVkhUDtm2bHuLJYqMTVMQR5AP1N0CEaGQkyGayt+3BQUupThFxPZiihYBP3BZHAI2L8tJDQ+yj3Yl4CFEApJiiQyYk4ehVKoAyvZhMSQQSzghUhpiuyhJlVnbK7Jf2waNHHUKd1HWeJ0WGs00ypExAAA=") format("woff2");}.iconfont-aliyun-captcha {font-family: "aliyun-captcha-iconfont" !important;font-size: 16px;font-style: normal;-webkit-font-smoothing: antialiased;-moz-osx-font-smoothing: grayscale;}.aliyun-captcha .icon-close-line:before {content: "\\e67e";}</style>\n\n  \x3Cscript type="module" crossorigin="" src="/assets/index-1ca43166.js">\x3C/script>\n  <link rel="stylesheet" href="/assets/index-05db0197.css">\n</head>\n\n<body>\n  <div id="root"><div class="login-bg-container w-full h-screen border" style="padding-top: calc(-300px + 50vh);"><div class="absolute w-56 h-40 rounded-full blur-3xl opacity-50 left-36 top-36 bg-blue-400"></div><div class="absolute w-56 h-40 rounded-full blur-3xl opacity-50 w-72 h-52  right-36 bottom-36 bg-orange-400"></div><div class="w-[800px] h-[600px] grid grid-cols-2 mx-auto gap-12 relative z-10"><div><div class="flex gap-3 items-center mb-2"><img src="/assets/logo-cd55652f.png" alt="" class="w-8 h-8"><div class="select-none text-2xl" style="color: rgb(146, 84, 222);"><b>集蜂云</b></div></div><div class="text-gray-500 text-sm mt-2">一个可以让开发者在上面构建、部署、运行、发布采集器的数据采集云平台。</div><div class="mt-20"></div><div class="flex flex-wrap flex-row items-center mt-2" style="gap: 1rem;"><span role="img" aria-label="check" class="anticon anticon-check  text-green-700"><svg viewBox="64 64 896 896" focusable="false" data-icon="check" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 00-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z"></path></svg></span><div>专注于业务，其它的交给平台</div></div><div class="flex flex-wrap flex-row items-center mt-2" style="gap: 1rem;"><span role="img" aria-label="check" class="anticon anticon-check  text-green-700"><svg viewBox="64 64 896 896" focusable="false" data-icon="check" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 00-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z"></path></svg></span><div>高性能、大规模、弹性伸缩</div></div><div class="flex flex-wrap flex-row items-center mt-2" style="gap: 1rem;"><span role="img" aria-label="check" class="anticon anticon-check  text-green-700"><svg viewBox="64 64 896 896" focusable="false" data-icon="check" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 00-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z"></path></svg></span><div>只需几行代码，即可接入平台</div></div><div class="flex flex-wrap flex-row items-center mt-2" style="gap: 1rem;"><span role="img" aria-label="check" class="anticon anticon-check  text-green-700"><svg viewBox="64 64 896 896" focusable="false" data-icon="check" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 00-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z"></path></svg></span><div>发布到市场，将技术转化为被动收入</div></div><div class="flex flex-wrap flex-row items-center mt-2" style="gap: 1rem;"><span role="img" aria-label="check" class="anticon anticon-check  text-green-700"><svg viewBox="64 64 896 896" focusable="false" data-icon="check" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 00-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z"></path></svg></span><div>低成本，按时长付费，用多少付多少</div></div></div><div class="border rounded-lg p-4 bg-white"><div><div class="flex items-start justify-between"><div class="ant-tabs ant-tabs-top ant-tabs-large mt-[-15px] css-9kmff0"><div role="tablist" class="ant-tabs-nav"><div class="ant-tabs-nav-wrap"><div class="ant-tabs-nav-list" style="transform: translate(0px, 0px);"><div data-node-key="2" class="ant-tabs-tab ant-tabs-tab-active"><div role="tab" aria-selected="true" class="ant-tabs-tab-btn" tabindex="0" id="rc-tabs-0-tab-2" aria-controls="rc-tabs-0-panel-2">密码登录</div></div><div data-node-key="1" class="ant-tabs-tab"><div role="tab" aria-selected="false" class="ant-tabs-tab-btn" tabindex="0" id="rc-tabs-0-tab-1" aria-controls="rc-tabs-0-panel-1">验证码登录</div></div><div class="ant-tabs-ink-bar" style="width: 64px; left: 32px; transform: translateX(-50%);"></div></div></div><div class="ant-tabs-nav-operations ant-tabs-nav-operations-hidden"><button type="button" class="ant-tabs-nav-more" tabindex="-1" aria-hidden="true" aria-haspopup="listbox" aria-controls="rc-tabs-0-more-popup" id="rc-tabs-0-more" aria-expanded="false" style="visibility: hidden; order: 1;"><span role="img" aria-label="ellipsis" class="anticon anticon-ellipsis"><svg viewBox="64 64 896 896" focusable="false" data-icon="ellipsis" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M176 511a56 56 0 10112 0 56 56 0 10-112 0zm280 0a56 56 0 10112 0 56 56 0 10-112 0zm280 0a56 56 0 10112 0 56 56 0 10-112 0z"></path></svg></span></button></div></div><div class="ant-tabs-content-holder"><div class="ant-tabs-content ant-tabs-content-top"><div role="tabpanel" tabindex="0" aria-hidden="false" class="ant-tabs-tabpane ant-tabs-tabpane-active" id="rc-tabs-0-panel-2" aria-labelledby="rc-tabs-0-tab-2"></div></div></div></div><div class="flex py-1 text-sm cursor-pointer text-blue-500  ">注册<span role="img" aria-label="right" class="anticon anticon-right"><svg viewBox="64 64 896 896" focusable="false" data-icon="right" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M765.7 486.8L314.9 134.7A7.97 7.97 0 00302 141v77.3c0 4.9 2.3 9.6 6.1 12.6l360 281.1-360 281.1c-3.9 3-6.1 7.7-6.1 12.6V883c0 6.7 7.7 10.4 12.9 6.3l450.8-352.1a31.96 31.96 0 000-50.4z"></path></svg></span></div></div></div><div class="mt-6"></div><div class="h-8 relative overflow-hidden text-xs border rounded-md flex gap-1 transition-all bg-gray-50 focus:bg-blue-300 focus:outline-non focus:ring-4 hover:border-blue-300 hover:bg-white"><input class="w-full h-full outline-none flex-1 bg-transparent px-2" placeholder="请输入账号/手机号/邮箱" type="text" value=""></div><div class="h-8 relative overflow-hidden text-xs border rounded-md flex gap-1 transition-all bg-gray-50 focus:bg-blue-300 focus:outline-non focus:ring-4 hover:border-blue-300 hover:bg-white mt-4"><input class="w-full h-full outline-none flex-1 bg-transparent px-2" placeholder="请输入密码" type="password" value=""><div class="flex-shrink-0 h-full flex items-center justify-center px-2 text-gray-500 bg-transparent cursor-pointer"><span role="img" aria-label="eye-invisible" class="anticon anticon-eye-invisible"><svg viewBox="64 64 896 896" focusable="false" data-icon="eye-invisible" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M942.2 486.2Q889.47 375.11 816.7 305l-50.88 50.88C807.31 395.53 843.45 447.4 874.7 512 791.5 684.2 673.4 766 512 766q-72.67 0-133.87-22.38L323 798.75Q408 838 512 838q288.3 0 430.2-300.3a60.29 60.29 0 000-51.5zm-63.57-320.64L836 122.88a8 8 0 00-11.32 0L715.31 232.2Q624.86 186 512 186q-288.3 0-430.2 300.3a60.3 60.3 0 000 51.5q56.69 119.4 136.5 191.41L112.48 835a8 8 0 000 11.31L155.17 889a8 8 0 0011.31 0l712.15-712.12a8 8 0 000-11.32zM149.3 512C232.6 339.8 350.7 258 512 258c54.54 0 104.13 9.36 149.12 28.39l-70.3 70.3a176 176 0 00-238.13 238.13l-83.42 83.42C223.1 637.49 183.3 582.28 149.3 512zm246.7 0a112.11 112.11 0 01146.2-106.69L401.31 546.2A112 112 0 01396 512z"></path><path d="M508 624c-3.46 0-6.87-.16-10.25-.47l-52.82 52.82a176.09 176.09 0 00227.42-227.42l-52.82 52.82c.31 3.38.47 6.79.47 10.25a111.94 111.94 0 01-112 112z"></path></svg></span></div></div><div class="mt-8"><button disabled="" class="rounded transition-colors duration-200 flex items-center justify-center gap-1 h-fit text-white bg-blue-500  medium px-3 py-1 text-sm cursor-not-allowed opacity-50 w-full h-8" style="min-height: 1.75rem;">登录</button></div></div></div></div></div>\n  \n\n\n\n</body><div class="xl-chrome-ext-bar_4DB361DE-01F7-4376-B494-639E489D19ED" id="xl_chrome_ext_4DB361DE-01F7-4376-B494-639E489D19ED" data-v-app="" style="display: block;"><div class=""><div id="xl_chrome_ext_video_tag_wrapper_4DB361DE-01F7-4376-B494-639E489D19ED" config="[object Object]" uiversion="v2" exception="true" latestvideosrc="" isshowvideotag="false" isshowdownloadbar="true" isshowcloudaddbar="false"><div class="_video_op_wrapper_96mx8_1" config="[object Object]" uiversion="v2" style="display: none;"><ul class="_video_op_list_96mx8_17"><li class="_op_item_96mx8_39 _download_96mx8_45"><span class="_op_icon_96mx8_25"></span><span class="_op_text_96mx8_31">下载</span></li><li class="_op_item_96mx8_39 _screen_96mx8_51"><span class="_op_icon_96mx8_25"></span><span class="_op_text_96mx8_31">投屏</span></li></ul></div></div><div class="badge_wrapper_4DB361DE-01F7-4376-B494-639E489D19ED _badge_wrapper_wnbzb_1" id="badge_wrapper_4DB361DE-01F7-4376-B494-639E489D19ED"><div class="_logo_wnbzb_24"></div><span class="_line_wnbzb_32"></span><div class="_text_wrapper_wnbzb_39"><span class="_download_icon_wnbzb_51"></span><span class="_text_wnbzb_39">高速下载</span></div></div>\x3C!---->\x3C!---->\x3C!---->\x3C!----><div class="_container_wq4mj_4">\x3C!----></div></div></div></html>`
    }, 'documentElement'),
    createEvent: function createEvent() {
        AsObj.print('document.createEvent:', arguments)
        if (arguments[0] === 'TouchEvent') {
            new TypeError("VM2052:1 Uncaught DOMException: Failed to execute 'createEvent' on 'Document': The provided event type ('TouchEvent') is invalid.")
        }
    },
    hasFocus:function hasFocus() {
        AsObj.print('document.hasFocus:', arguments)
        return false;
    },
    getElementsByTagName: function getElementsByTagName() {
        AsObj.print('document.getElementsByTagName:', arguments)
        if (arguments[0] === 'body') {
            collects = [document.body]
            collects.__proto__ = HTMLCollection.prototype;
            return watch(collects,'collects')
        }
        if (arguments[0] === 'script') {
            return scripts
        }
    },
    hasPrivateToken: function hasPrivateToken() {
        AsObj.print('document.hasPrivateToken:', arguments)
    },
    hasRedemptionRecord: function hasRedemptionRecord() {
        AsObj.print('document.hasRedemptionRecord:', arguments)
    },
    referrer: '',
    hidden: false,
    webkitHidden: false,
    browsingTopics: function browsingTopics() {
        AsObj.print('document.browsingTopics:', arguments)
    },
    hasStorageAccess: function hasStorageAccess() {
        AsObj.print('document.hasStorageAccess:', arguments)
    },
    requestStorageAccess: function requestStorageAccess() {
        AsObj.print('document.requestStorageAccess:', arguments)
    },
    requestStorageAccessFor: function requestStorageAccessFor() {
        AsObj.print('document.requestStorageAccessFor:', arguments)
    },
};
document.__proto__ = HTMLDocument.prototype;
document.__proto__.__proto__ = Document.prototype;
document.__proto__.__proto__.__proto__ = Node.prototype;
document.__proto__.__proto__.__proto__.__proto__ = EventTarget.prototype;
HTMLDocument.__proto__ = Document;
HTMLDocument.__proto__.__proto__ = Node;
HTMLDocument.__proto__.__proto__.__proto__ = EventTarget;
Document.__proto__ = Node;
Document.__proto__.__proto__ = EventTarget;
Node.__proto__ = EventTarget;

Document.prototype.createElement = function createElement() { }
safeFunction(Document.prototype.createElement)
safeFunction(document.createElement)
Document.prototype.createEvent = function createEvent() { }
safeFunction(Document.prototype.createEvent)
safeFunction(document.createEvent)
safeFunction(document.getElementsByTagName)
safeFunction(document.body.addEventListener)
safeFunction(document.documentElement.getAttribute)
safeFunction(document.hasPrivateToken)
safeFunction(document.hasRedemptionRecord)
safeFunction(document.body.appendChild)
safeFunction(document.body.removeChild)
safeFunction(document.head.insertBefore)
safeFunction(document.head.removeChild)
safeFunction(document.hasFocus)
safeFunction(document.browsingTopics)
safeFunction(document.hasStorageAccess)
safeFunction(document.requestStorageAccess)
safeFunction(document.requestStorageAccessFor)

scripts[0].parentNode = document.head;
scripts[1].parentNode = document.head;
div.parentNode = document.body;

createTagProto('HTMLAllCollection')
HTMLAllCollection.prototype[Symbol.iterator] = function* () {
    for (let i = 0; i < this.length; i++) {
        yield this[i];
    }
}
document.all = undetectable;
document.all.length = 111
document.all[0] = document.documentElement;
document.all.__proto__ = HTMLAllCollection.prototype;

createTagProto('Plugin');
createTagProto('PluginArray');
plugins0 = {
    name: 'PDF Viewer',
    filename: 'internal-pdf-viewer',
    description:'Portable Document Format',
    length: 2,
    '0': {
        type: 'application/pdf',
    },
    '1':{
        type:'text/pdf'
    }
}
plugins0['0'].enabledPlugin = plugins0;
plugins0['1'].enabledPlugin = plugins0;
plugins1 = {
    name: 'Chrome PDF Viewer',
    filename: 'internal-pdf-viewer',
    description:'Portable Document Format',
    length: 2,
    '0': {
        type:'application/pdf'
    },
    '1': {
        type:'text/pdf'
    }
}
plugins1['0'].enabledPlugin = plugins1;
plugins1['1'].enabledPlugin = plugins1;
plugins2 = {
    name: 'Chromium PDF Viewer',
    filename: 'internal-pdf-viewer',
    description:'Portable Document Format',
    length: 2,
    '0': {
        type:'application/pdf'
    },
    '1': {
        type:'text/pdf'
    }
}
plugins2['0'].enabledPlugin = plugins2;
plugins2['1'].enabledPlugin = plugins2;
plugins3 = {
    name: 'Microsoft Edge PDF Viewer',
    filename: 'internal-pdf-viewer',
    description:'Portable Document Format',
    length: 2,
    '0':{
        type:'application/pdf'
    },
    '1': {
        type:'text/pdf'
    }
}
plugins3['0'].enabledPlugin = plugins3;
plugins3['1'].enabledPlugin = plugins3;
plugins4 = {
    name: 'WebKit built-in PDF',
    filename: 'internal-pdf-viewer',
    description:'Portable Document Format',
    length: 2,
    '0': {
        type:'application/pdf'
    },
    '1':{
        type:'text/pdf'
    }
}
plugins4['0'].enabledPlugin = plugins4;
plugins4['1'].enabledPlugin = plugins4;
plugins = {
    length: 5,
    '0': plugins0,
    '1': plugins1,
    '2': plugins2,
    '3': plugins3,
    '4': plugins4,
    namedItem : function (name) {
        AsObj.print('Plugin-namedItem:', name)
    },
    item: function (index) {
        AsObj.print('Plugin-item:', index)
    },
    refresh: function () {
        AsObj.print('Plugin-refresh:',arguments)
    },
}
plugins.__proto__ = PluginArray.prototype;

MimeTypeArray = function MimeTypeArray() {
    this.length = 2;
    this['0'] = {
        suffixes: 'pdf',
        type: 'application/pdf',
        description:"Portable Document Format",
        enabledPlugin: plugins0
    };
    this['1'] = {
        suffixes: 'pdf',
        type: 'text/pdf',
        description:"Portable Document Format",
        enabledPlugin: plugins0
    };
};
MimeTypeArray.prototype.toString = function () { return '[object MimeTypeArray]'; }
MimeTypeArray.toString = function () { return 'function MimeTypeArray() { [native code] }'; }
Object.defineProperties(MimeTypeArray.prototype, { [Symbol.toStringTag]: { value: 'MimeTypeArray' } })
MimeTypeArrayc = new MimeTypeArray();
MimeTypeArrayc[Symbol.iterator] = function* () {
    for (let key in this) {
        yield this[key];
    }
}

// 创建电池管理器对象原型 
const BatteryManager = {
    level: 1,
    charging: true,
    chargingTime: 0,
    dischargingTime: Infinity,
    onchargingchange: null,
    onlevelchange: null,
    toString: function toString() {
      return `BatteryManager {
        charging: ${this.charging}, 
        level: ${this.level}, 
        chargingTime: ${this.chargingTime}, 
        dischargingTime: ${this.dischargingTime} 
      }`
    }
}
window.BatteryManager = BatteryManager;

Promise2 = {
    then: function () {
        return this;
    },
    catch: function (){},
};

createTagProto('Bluetooth');
createTagProto('Navigator');
Navigator.prototype.hardwareConcurrency = 11;
Navigator.prototype.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0';
Navigator.prototype.appVersion = '5.0 (Macintosh)'
Navigator.prototype.appName = 'Netscape';
Navigator.prototype.appCodeName = 'Mozilla';
Navigator.prototype.vendor = '';
Navigator.prototype.maxTouchPoints = 0;
Navigator.prototype.platform = 'MacIntel';
Navigator.prototype.adAuctionComponents = function adAuctionComponents() {
    AsObj.print('adAuctionComponents:::', arguments)
}
safeFunction(Navigator.prototype.adAuctionComponents)
Navigator.prototype.runAdAuction = function runAdAuction() {
    AsObj.print('runAdAuction:::', arguments)
}
safeFunction(Navigator.prototype.runAdAuction)
Navigator.prototype.canLoadAdAuctionFencedFrame = makeFunction('canLoadAdAuctionFencedFrame')
Navigator.prototype.deprecatedReplaceInURN = makeFunction('deprecatedReplaceInURN')
Navigator.prototype.deprecatedURNToURL = makeFunction('deprecatedURNToURL')
Navigator.prototype.joinAdInterestGroup = makeFunction('joinAdInterestGroup')
Navigator.prototype.leaveAdInterestGroup = makeFunction('leaveAdInterestGroup')
Navigator.prototype.updateAdInterestGroups = makeFunction('updateAdInterestGroups')
Navigator.prototype.connection = watch({
    downlink: 10,
    effectiveType: '4g',
    rtt: 50,
    saveData: false,
},'connection')
Navigator.prototype.language = 'zh-CN';
Navigator.prototype.languages = ['zh-CN', 'zh'];
Navigator.prototype.plugins = plugins;
Navigator.prototype.webdriver = false;
Navigator.prototype.cookieEnabled = true;
Navigator.prototype.onLine = true;
Navigator.prototype.doNotTrack = null;
Navigator.prototype.bluetooth = {};
Navigator.prototype.product = 'Gecko'
Navigator.prototype.deviceMemory = 8
Navigator.prototype.mediaDevices = watch({
    enumerateDevices: function enumerateDevices() {
        return new Promise((resolve, reject) => {
            const offer = [
                {deviceId: '', kind: 'audioinput', label: '', groupId: ''},
                {deviceId: '', kind: 'videoinput', label: '', groupId: ''},
                {deviceId: '', kind: 'audiooutput', label: '', groupId: ''},
            ]
            resolve(offer);
        });
    },
    getUserMedia: function getUserMedia() {
        AsObj.print('getUserMedia:::', arguments)
    }
},'mediaDevices')
Navigator.prototype.storage = {
    estimate: function estimate() {
        AsObj.print('estimate:::', arguments)
        return new Promise((resolve, reject) => {
            const offer = {
                usage: 3367, // 1GB
                quota: 128136395980, // 1GB,
                usageDetails: {caches: 512, indexedDB: 2855}
            };
            resolve(offer);
        });
    }
}
Navigator.prototype.webkitPersistentStorage = watch({},'webkitPersistentStorage')
Navigator.prototype.webkitTemporaryStorage = watch({
    queryUsageAndQuota: function queryUsageAndQuota() {
        AsObj.print('queryUsageAndQuota:::', arguments)
        return new Promise((resolve, reject) => {    
            const offer = {
                usage: 1024 * 1024 * 1024, // 1GB
                quota: 1024 * 1024 * 1024, // 1GB
            };
            resolve(offer);
        });
    }
},'webkitTemporaryStorage')
Navigator.prototype.bluetooth.__proto__ = Bluetooth.prototype;
Navigator.prototype.javaEnabled = function javaEnabled() {
    return false
};
safeFunction(Navigator.prototype.javaEnabled)
Navigator.prototype.getBattery = function getBattery() {
    AsObj.print('getBattery:::', arguments)
    return Promise.resolve({
        __proto__: BatteryManager,
        // 动态参数配置（示例值）
        level: 1,
        charging: true,
        dischargingTime: 'Infinity' // 2小时放电时间 
    })
}
safeFunction(Navigator.prototype.getBattery)
Navigator.prototype.registerProtocolHandler = function registerProtocolHandler() {
    AsObj.print('registerProtocolHandler:::',arguments)
}
safeFunction(Navigator.prototype.registerProtocolHandler)
Navigator.prototype.mimeTypes = {
    __proto__:MimeTypeArray.prototype,
    length: 2,
    0: { type: "application/pdf", description: "Portable Document Format", suffixes: "pdf" },
    1: { type: "text/pdf", description: "Chrome PDF Viewer", suffixes: "pdf" },

    item(i) {
        return this[i] || null;
    },

    namedItem(name) {
        return name === "application/pdf" ? this[0] : null;
    },

    values() {
        let i = 0;
        return {
            next: () =>
                i < this.length
                    ? { value: this[i++], done: false }
                    : { value: undefined, done: true },
            [Symbol.iterator]() { return this; }
        };
    },

    [Symbol.iterator]() {
        return this.values();
    },

    [Symbol.toStringTag]: "MimeTypeArray"
};
Navigator.prototype.geolocation = {
    getCurrentPosition: function getCurrentPosition() {
        return Promise2;
    }
}
Navigator.prototype.doNotTrack = null;
Navigator.prototype.permissions = watch({
    query: function query() {
        AsObj.print('permissions.query:::', arguments)
        return new Promise((resolve, reject) => {    
            const offer = {
                state: 'prompt',
                onchange: null,
                name:'notifications'
            };
            resolve(offer);
        });
    }
},'permissions')
Navigator.prototype.productSub = '20030107'
Navigator.prototype.getGamepads = function getGamepads() {
    AsObj.print('getGamepads:::', arguments)
    return [null,null,null,null]
}
safeFunction(Navigator.prototype.getGamepads)

Navigator.prototype.deprecatedRunAdAuctionEnforcesKAnonymity = false
Navigator.prototype.userAgentData = undefined;

navigator = {};
navigator.__proto__ = Navigator.prototype;

createTagProto('Location');
// location = {
//     "ancestorOrigins": {},
//     "href": "https://www.chinaexpressair.com/api/order/createOrder",
//     "origin": "https://www.chinaexpressair.com",
//     "protocol": "https:",
//     "host": "www.chinaexpressair.com",
//     "hostname": "www.chinaexpressair.com",
//     "port": "",
//     "pathname": "/api/order/createOrder",
//     "search": "",
//     "hash": ""
// };
location = {
    "ancestorOrigins": {},
    "href": "https://resource.51xf.cn/H5/captcha.html",
    "origin": "https://resource.51xf.cn",
    "protocol": "https:",
    "host": "resource.51xf.cn",
    "hostname": "resource.51xf.cn",
    "port": "",
    "pathname": "/CSMBP/bookProcess/avPrice/getAvPrice",
    "search": "",
    "hash": ""
};

location.__proto__ = Location.prototype;
location.toString = function toString() {
    return this.href;
}

MutationObserver = function MutationObserver() {
    AsObj.print('MutationObserver:::', arguments)
    return watch({
        observe:function observe() {
            AsObj.print('observe:::', arguments)
        },
        takeRecords: function takeRecords() {
            AsObj.print('[takeRecords]:::', arguments)
            return [watch({
                previousSibling:''
            },'mutationRecord')];
        },
        disconnect: function disconnect() { }
    },'MutationObserver')
}
safeFunction(MutationObserver)
PromiseRejectionEvent = makeFunction('PromiseRejectionEvent')
dispatchEvent = makeFunction('dispatchEvent')
Text = makeFunction('Text')
focus = makeFunction('focus')
blur = makeFunction('blur')
Image = makeFunction('Image')
File = makeFunction('File')
confirm = makeFunction('confirm')
Worker = makeFunction('Worker')
Option = makeFunction('Option')
window.__ALIYUN_CRYPT = require_('crypto-js');
window.__ALIYUN_CRYPT.MD5_ = window.__ALIYUN_CRYPT.MD5;
// window.__ALIYUN_CRYPT.MD5 = function MD5() {
//     res = window.__ALIYUN_CRYPT.MD5_.apply(this, arguments);
//     AsObj.print_('MD5:::', arguments[0],'结果：',res+'')
//     return res
// }
resizeBy = makeFunction('resizeBy')
moveTo = makeFunction('moveTo')
prompt = makeFunction('prompt')
resizeTo = makeFunction('resizeTo')
close = makeFunction('close')
MimeType = makeFunction('MimeType')
Notification = makeFunction('Notification')
Attr = makeFunction('Attr')
alert = makeFunction('alert')
scrollBy = makeFunction('scrollBy')
CSSFontPaletteValuesRule = makeFunction('CSSFontPaletteValuesRule')
CSSFontPaletteValuesRule.prototype.name = 'CSSFontPaletteValuesRule'
Range = makeFunction('Range')
Element = makeFunction('Element')
PointerEvent = makeFunction('PointerEvent')
scrollTo = makeFunction('scrollTo')
Audio = makeFunction('Audio')
scroll = makeFunction('scroll')
open = makeFunction('open')
moveBy = makeFunction('moveBy')
SecurityPolicyViolationEvent = makeFunction('SecurityPolicyViolationEvent')
SecurityPolicyViolationEvent.prototype.columnNumber = 0
ElementInternals = makeFunction('ElementInternals')
SVGAnimationElement = makeFunction('SVGAnimationElement')
SVGAnimationElement.prototype.onend = null
Crypto = makeFunction('Crypto')
crypto = require_('crypto');
crypto.__proto__ = Crypto.prototype;
crypto.toString = function toString() {
    return '[object Crypto]'
}
Gamepad = makeFunction('Gamepad')
ClipboardItem = function ClipboardItem() {
    AsObj.print('ClipboardItem:::', arguments)
    return watch({
        types:['text/plain']
    },'clipboardItem')
}
safeFunction(ClipboardItem)

div_cpstyle = watch({
    __proto__: CSSStyleDeclaration.prototype,
    hyphenateCharacter:'auto',
    cursor:'auto',
    offsetPath: 'none',
    // color:"rgba(0, 0, 0, 0.85)"
}, 'div_cpstyle')

color_lists = ["rgba(0, 0, 0, 0.85)","rgba(0, 0, 0, 0.85)","rgb(0, 102, 204)","rgb(0, 0, 0)","rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(255, 255, 255)","rgb(240, 240, 240)","rgb(240, 240, 240)","rgb(0, 0, 0)","rgb(240, 240, 240)","rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(109, 109, 109)","rgb(0, 120, 215)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(128, 128, 128)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(0, 102, 204)","rgb(255, 255, 0)","rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(255, 255, 255)","rgb(25, 103, 210)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(240, 240, 240)","rgb(0, 0, 0)","rgb(0, 0, 0)","rgb(0, 0, 0)","rgb(0, 102, 204)","rgb(255, 255, 255)","rgb(0, 0, 0)","rgb(0, 0, 0)","rgb(25, 103, 210)","rgb(255, 255, 255)"]
color_num = 0
Object.defineProperty(div_cpstyle, 'color', {
    get: function () {
        // AsObj.print_('get color:::')
        color_num++
        return color_lists[color_num - 1]
    }
})

SVGFEConvolveMatrixElement = makeFunction('SVGFEConvolveMatrixElement')
CSSRule = makeFunction('CSSRule')
SVGFEConvolveMatrixElement.prototype.kernelUnitLengthY = 1
MediaStreamTrack = makeFunction('MediaStreamTrack')
MediaStreamTrack.prototype.readyState = 'live'
getComputedStyle = function getComputedStyle() {
    if (arguments[0] + '' === '[object HTMLDivElement]') {
        return div_cpstyle
    }
    debugger
    AsObj.print('getComputedStyle:::', arguments)
}
safeFunction(getComputedStyle)
matchMedia = function matchMedia() {
    AsObj.print('matchMedia:::', arguments)
    resObj = {media: arguments[0], matches: false, onchange: null}
    if (arguments[0] === '(color-gamut: rec2020)') {
        return resObj
    }
    if (arguments[0] === '(color-gamut: p3)') {
        resObj.matches = false
        return resObj
    }
    if (arguments[0] === '(min-monochrome: 0)') {
        resObj.matches = true
        return resObj
    }
    if (arguments[0] === '(prefers-contrast: no-preference)') {
        resObj.matches = true
        return resObj
    }
    if (arguments[0] === '(min-monochrome: 0)') {
        resObj.matches = true
        return resObj
    }
    if (arguments[0] === '(max-monochrome: 0)') {
        resObj.matches = true
        return resObj
    }
    if (arguments[0] === '(forced-colors: none)') {
        resObj.matches = true
        return resObj
    }
    if (arguments[0] === '(prefers-reduced-motion: no-preference)') {
        resObj.matches = true
        return resObj
    }
    if (arguments[0] === '(color-gamut: srgb)') {
        resObj.matches = true
        return resObj
    }
    return resObj
}
safeFunction(matchMedia)

createTagProto('Screen');
createTagProto('ScreenOrientation');
orientation = {
    angle: 0,
    type: "landscape-primary",
    onchange: null
};
orientation.__proto__ = ScreenOrientation.prototype;
Screen.prototype = Object.assign(Screen.prototype, {
    availHeight: 1728,
    availLeft: 0,
    availTop: 0,
    availWidth: 1084,
    colorDepth: 24,
    height: 1728,
    isExtended: false,
    onchange: null,
    pixelDepth: 24,
    width: 1117,
    orientation: orientation
})
screen = {};
screen.__proto__ = Screen.prototype;

createTagProto('History');
history = {};
history.__proto__ = History.prototype;

chrome = undefined;

createTagProto('Storage');
local = {
};
localStorage = {
    getItem: function getItem(key) {
        AsObj.print("localStorage.getItem::", arguments);
        if (!local[key]) {
            return null;
        }
        return local[key];
    },
    setItem: function setItem(key, value) {
        AsObj.print("localStorage.setItem::", arguments);
        local[key] = value;
    },
    clear: function clear() {
        local = {};
    },
    removeItem: function removeItem(key) {
        AsObj.print("localStorage.removeItem::", arguments);
        delete local[key];
    }
}
localStorage.__proto__ = Storage.prototype;
sessionStorage = {
    getItem: function getItem(key) {
        AsObj.print("sessionStorage.getItem::", arguments);
        if (!local[key]) {
            return null;
        }
        return local[key];
    },
    setItem: function setItem(key, value) {
        AsObj.print("sessionStorage.setItem::", arguments);
        local[key] = value;
    },
    clear: function clear() {
        local = {};
    },
    removeItem: function removeItem(key) {
        AsObj.print("sessionStorage.removeItem::", arguments);
        delete local[key];
    }
}
sessionStorage.__proto__ = Storage.prototype;

indexdb = watch({}, 'indexedDB.open');
Object.defineProperty(indexdb, 'onupgradeneeded', {
    set: function (value) {
        value(watch({
            target: watch({
                result: watch({
                    createObjectStore: function createObjectStore() {
                        AsObj.print("IDBObjectStore.createObjectStore::", arguments);
                        if (arguments[0] === 'data') {
                            return watch({
                            },'createObjectStore.data')
                        }
                    }
                },'onupgradeneeded.target.result')
            },'onupgradeneeded.target')
        },'indexedDB.onupgradeneeded'))
    }
})
Object.defineProperty(indexdb, 'onsuccess', {
    set: function (value) {
        value(watch({
            target: watch({
                result: watch({
                    close:function close(){},
                },'onsuccess.target.result')
            },'onsuccess.target')
        },'indexedDB.onsuccess'))
    }
})
createTagProto('IDBFactory',['open','deleteDatabase'])
indexedDB = {
    __proto__: IDBFactory.prototype,
    open: function open() {
        AsObj.print("indexedDB.open::", arguments);
        debugger
        return indexdb
    },
    deleteDatabase: function deleteDatabase() {
        AsObj.print("indexedDB.deleteDatabase::", arguments);
        debugger
        // indexdb = undefined;
        // return indexdb
    }
}
safeFunction(indexedDB.open)
safeFunction(indexedDB.deleteDatabase)
Document.prototype.onpointerlockchange = null
CSS = watch({
    supports: function supports() {
        AsObj.print("CSS.supports::", arguments);
        return true;
    },
    percent: function percent() {
        AsObj.print("CSS.percent::", arguments);
    },
},'CSS')

Object.getOwnPropertyNames_ = Object.getOwnPropertyNames;
Object.getOwnPropertyNames = function getOwnPropertyNames() {
    if (arguments[0] === window) {
        return ["window","self","document","name","location","customElements","history","navigation","locationbar","menubar","personalbar","scrollbars","statusbar","toolbar","status","closed","frames","length","top","opener","parent","frameElement","navigator","origin","external","screen","innerWidth","innerHeight","scrollX","pageXOffset","scrollY","pageYOffset","visualViewport","screenX","screenY","outerWidth","outerHeight","devicePixelRatio","event","clientInformation","screenLeft","screenTop","styleMedia","onsearch","trustedTypes","performance","onappinstalled","onbeforeinstallprompt","crypto","indexedDB","sessionStorage","localStorage","onbeforexrselect","onabort","onbeforeinput","onbeforematch","onbeforetoggle","onblur","oncancel","oncanplay","oncanplaythrough","onchange","onclick","onclose","oncontentvisibilityautostatechange","oncontextlost","oncontextmenu","oncontextrestored","oncuechange","ondblclick","ondrag","ondragend","ondragenter","ondragleave","ondragover","ondragstart","ondrop","ondurationchange","onemptied","onended","onerror","onfocus","onformdata","oninput","oninvalid","onkeydown","onkeypress","onkeyup","onload","onloadeddata","onloadedmetadata","onloadstart","onmousedown","onmouseenter","onmouseleave","onmousemove","onmouseout","onmouseover","onmouseup","onmousewheel","onpause","onplay","onplaying","onprogress","onratechange","onreset","onresize","onscroll","onsecuritypolicyviolation","onseeked","onseeking","onselect","onslotchange","onstalled","onsubmit","onsuspend","ontimeupdate","ontoggle","onvolumechange","onwaiting","onwebkitanimationend","onwebkitanimationiteration","onwebkitanimationstart","onwebkittransitionend","onwheel","onauxclick","ongotpointercapture","onlostpointercapture","onpointerdown","onpointermove","onpointerrawupdate","onpointerup","onpointercancel","onpointerover","onpointerout","onpointerenter","onpointerleave","onselectstart","onselectionchange","onanimationend","onanimationiteration","onanimationstart","ontransitionrun","ontransitionstart","ontransitionend","ontransitioncancel","onafterprint","onbeforeprint","onbeforeunload","onhashchange","onlanguagechange","onmessage","onmessageerror","onoffline","ononline","onpagehide","onpageshow","onpopstate","onrejectionhandled","onstorage","onunhandledrejection","onunload","isSecureContext","crossOriginIsolated","scheduler","alert","atob","blur","btoa","cancelAnimationFrame","cancelIdleCallback","captureEvents","clearInterval","clearTimeout","close","confirm","createImageBitmap","fetch","find","focus","getComputedStyle","getSelection","matchMedia","moveBy","moveTo","open","postMessage","print","prompt","queueMicrotask","releaseEvents","reportError","requestAnimationFrame","requestIdleCallback","resizeBy","resizeTo","scroll","scrollBy","scrollTo","setInterval","setTimeout","stop","structuredClone","webkitCancelAnimationFrame","webkitRequestAnimationFrame","chrome","caches","cookieStore","ondevicemotion","ondeviceorientation","ondeviceorientationabsolute","sharedStorage","documentPictureInPicture","fetchLater","getScreenDetails","queryLocalFonts","showDirectoryPicker","showOpenFilePicker","showSaveFilePicker","originAgentCluster","viewport","onpageswap","onpagereveal","credentialless","fence","launchQueue","speechSynthesis","oncommand","onscrollend","onscrollsnapchange","onscrollsnapchanging","webkitRequestFileSystem","webkitResolveLocalFileSystemURL","_0x214a","_0x2d77","_0x37b5ef","_0x2bf836","_0xbc70","_0x4a0b","_0x517d2b","_0x562e14","_0x259dd9","_0x3b5fa7","_0x556a","_0x4424","_0x2e01","_0xd162","_0x181cbd","_0x4916f8","_0x4f64","_0x2dcbc0","_0x2687ce","_0x4d5f","_0x3e10b1","_0x3d68","_0x5946","_0x3509e3","_0x4343c0","_0x4402","_0x10ae12","_0x2ab8","_0x1ccb8e","_0x244a","_0xd5cc","_0x393431","_0x530c","_0x5e1d","_0x20cc3d","_0xbb7c84","_0x56f6ba","_0x23b2","_0x21dc","_0x1d9161","_0x3472","_0x1d65","_0x20b36d","_0x5d4713","_0x2c49c5","_0x2705","_0xe36946","_0x914e","_0x202ede","_0x2d72","_0x561b","_0x3fd366","_0x40fc","_0x256624","_0x34da","_0x3b7966","_0x2e93d8","_0x2643","_0x5208","_0x44b543","_0x42dcb8","_0x3b91","_0x3fc7c2","_0x151c","_0x141720","_0x4701","_0x7f0c","_0x105e8f","_0x518f","_0xe7f82d","_0x2aeadf","_0x1348","_0x8ac607","_0x3582","_0x2b1f42","_0x14c5","_0x531fef","_0x575c","_0x4e89","_0x354269","_0x2769","_0x76684d","_0xc26d","_0x2c741e","_0x4d84","_0x5c4df9","_0x2cd310","_0x2208","_0x502ed4","_0x1c4c","_0x5cf9","_0x54b910","_0x5481","_0x923287","_0x4b7319","_0xea8b","_0x5b3753","_0x395549","_0x5e40","_0x1032","_0x5c63","_0x2b3603","_0x51d8a3","_0x1f4b","_0x530e","_0x3e5671","_0x433945","_0xf8a2","_0x433025","_0x5a0c73","_0x1cba","_0xd92b","_0x117e","_0x478962","_0x3a1191","_0x1b09","_0x3d78","_0x10c3","_0x1ca784","_0xf8218a","_0x64f5d8","_0x43eb63","_0x59b5","_0x352e","_0x27a5e0","_0x4541","_0x12c095","_0x3fbc","_0x26aa","_0x547a","_0x57ac48","_0xeff39a","_0x1a2b04","_0x3228","_0x36bb","_0x11feb8","_0x38d5","_0x18d236","_0x17746b","_0x1af6","_0x2677","_0x1f78","_0x31e3","_0x2e4a16","_0x578c0d","_0x494c","_0x1924","_0x1206","_0x1b8d91","_0xb5df4","_0x43e8","_0xff775f","_0x5a85","_0x46a6","_0x5b3bdc","_0x1bb667","_0x5698","_0x33ff7b","_0x29f5","_0x9f1fee","_0x2963","_0x5e2a","_0x16cf9b","_0x382b","_0x2d6128","_0x4a8f","_0x279955","_0x5563","_0x31bb88","_0x158301","_0x1535","_0x14262c","_0x5970","_0x5bb8","_0x2f71df","_0x25d0","_0x45c35a","_0x24efac","_0x1835","_0x3037","_0x2b45c1","_0x59147a","_0x283ac2","_0x3b89","_0x33e9","_0x3698","_0x38eb72","_0x28d5","_0x18a0a0","_0x279ef0","_0x47c441","_0x5d67","_0x3798","regeneratorRuntime","__ALIYUN_CAPTCHA_UTILS","__ALIYUN_CRYPT","__AYF","__ALIYUN_CAPTCHA_TEXTS","head","TIMEOUT","initAliyunCaptcha","_FN"]
    }
    AsObj.print('[Object.getOwnPropertyNames:::]', arguments[0] + '')
    return Object.getOwnPropertyNames_.apply(this, arguments);
}
Object.getOwnPropertyNames.toString = function toString() {
    return 'function getOwnPropertyNames() { [native code] }'
}

webkitResolveLocalFileSystemURL = makeFunction('webkitResolveLocalFileSystemURL')
webkitMediaStream = makeFunction('webkitMediaStream')
webkitSpeechGrammar = makeFunction('webkitSpeechGrammar')
RTCEncodedAudioFrame = makeFunction('RTCEncodedAudioFrame')
FormDataEvent = makeFunction('FormDataEvent')

setInterval_ = setInterval;
setInterval = function setInterval() {
    AsObj.print('setInterval', arguments);
    return setInterval_.apply(this, arguments);
}
safeFunction(setInterval);

getdocument = function document() {
    return document;
}
getdocument.toString = function toString() {
    return 'function get document() { [native code] }'
}
getscreen = function screen() {
    return screen;
}
getscreen.toString = function toString() {
    return 'function get screen() { [native code] }'
}
setscreen = function screen() {
    return screen;
}
setscreen.toString = function toString() {
    return 'function set screen() { [native code] }'
}

getnavigator = function navigator() {
    return navigator;
}
getnavigator.toString = function toString() {
    return 'function get navigator() { [native code] }'
}

getlocalStorage = function localStorage() {
    return localStorage;
}
getlocalStorage.toString = function toString() {
    return 'function get localStorage() { [native code] }'
}


!function () {
    'user strict';
    // 当实列对象取自身某些元素或者函数时，找不到则去往原型上面去找
    // 检测 Function 执行某些js比如：(function() {}.constructor("return this")( ))  其实this就是window
    // eval可能检测：stack，log的堆栈, typeof、in、instanceof
    dtavm = { _log: console.log };

    // hook 描述符 可以获取到属性的描述符  --- 是否检测
    Object.getOwnPropertyDescriptor_ = Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptor = function getOwnPropertyDescriptor() {
        if (arguments[0] === window) {
            if (arguments[1] === 'document') {
                return {
                    configurable: false,
                    enumerable: true,
                    get: getdocument,
                    set:undefined
                }
            }
            if (arguments[1] === 'screen') {
                return {
                    configurable: true,
                    enumerable: true,
                    get: getscreen,
                    set:setscreen
                }
            }
            if (arguments[1] === 'navigator') {
                return {
                    configurable: true,
                    enumerable: true,
                    get: getnavigator,
                    set:undefined
                }
            }
            if (arguments[1] === 'webdriver') {
                return undefined
            }
            if (arguments[1] === 'localStorage') {
                return {
                    configurable: true,
                    enumerable: true,
                    get: getlocalStorage,
                    set:undefined
                }
            }
        }
        if (arguments[0] === Navigator.prototype || arguments[0] === navigator.__proto__) {
            return {
                configurable: true,
                enumerable: true,
                get: {
                    toString:function toString() { return 'function get '+arguments[1]+'() { [native code] }'; }
                },
                set:undefined
            }
        }

        // Object.defineProperties_ = Object.defineProperties;
        // Object.defineProperties = function defineProperties() {
        //     if (!arguments[1].hasOwnProperty('stack')) {
        //         return Object.defineProperties_.apply(this, arguments);
        //     }
        // }
        // AsObj.print_('[Object.getOwnPropertyDescriptor:::]', arguments[0]+'',arguments[1])
        return Object.getOwnPropertyDescriptor_.apply(this, arguments);
    }
    Object.getOwnPropertyDescriptor.toString = function toString() {
        return 'function getOwnPropertyDescriptor() { [native code] }'
    }
}();

// window._gpu = {
//     "fhgjjghdf": "Google Inc. (Intel)",
//     "xcvdfgfd": "ANGLE (Intel, Intel(R) UHD Graphics (0x00008A56) Direct3D11 vs_5_0 ps_5_0, D3D11)"
// }

for(let prop of Object.keys(console)){
    if(typeof console[prop]==='function'){
        console[prop] = function(){}
    }
    
}

Error = function () {
    debugger
    return watch({},'Error实例')
}

for(let prop of ['debug','error','info','log','trace','warn']){
    console[prop] = function(arg1,arg2,arg3){
        if (arg1 && arg2 && arg3) {
            debugger
            if(arg1==='%c%d'&&arg2==='font-size:0;color:transparent'){
                arg3.name;
                arg3.message;
            } 
        }
    }
}


// Firefox trace baseline. Stable capability fields live in this object;
// per-run values are assigned below before the object is exposed to FeiLin.
const args = process_.argv.slice(2);
deviceConfig = JSON.parse(args[0]);
window._ORDVD_huanj = {
    "dghfh565": "W.10054",
    "asdfasdf": "1.5",
    "sdfgsdf": 11,
    "zxcvzxcv": "Apple",
    "asdfccv": "Gecko",
    "sdfg433": "MacIntel",
    "sdfgsf4": "Firefox",
    "sdfgfds4": "142.0",
    "asdfd6": 3,
    "cvxgfh6": [
        "application/pdf",
        "text/pdf"
    ],
    "nvbcn65": false,
    "hdgfh65": 2,
    "fsdaf545": "Apple M1, or similar",
    "cvxbvc645": "Mozilla",
    "xcvbbc65": "",
    "fghf657": "",
    "ghhjf656": 0,
    "xdgfd6545": 0,
    "Whfgjhgj76": 0,
    "gdfhvcb6": "c7714802b27c8c2aa0cf82e0385668af",
    "fhgjgfhd675": 24,
    "v78d98s": "AwEEAQZZBwA=",
    "vbmnbn67": "",
    "vbjghj7": "30*0*0*0",
    "vbnmbn3": 30,
    "dfxvsdf4": 30,
    "asdfadsf34": "srgb",
    "cvbncv6": false,
    "fghgf6": false,
    "jhgkjgh": false,
    "cvfbbv2": 0,
    "fghjcv3": 0,
    "vbnmvbn4": "94433880daa9f55b02a5836769d31ee2",
    "fghjfgh5": "",
    "a87sg9": 12,
    "dfghfg64": "",
    "lk4n6ll": "Mac OS",
    "zvcxv234": "10.15",
    "asdfas434df": 1,
    "bvcxb": false,
    "fghjghs": "en-US+en-US+en",
    "fghjfghe": "Asia/Shanghai",
    "ifghjgfhjp": "183.192.132.175",
    "nghjdfgsh": "20-1709|23-3126|30-3|40-55|41-2978|70-3007",
    "csdfgdfd": true,
    "tyjhtyge": true,
    "jcvhve": true,
    "dfghcbn": "1117*1728",
    "ihgnghyt": true,
    "asdfd4545": 0,
    "jghfjfhg453": false,
    "dfsgdf87": false,
    "dfghfgdh6": "bf76663f179529d11abd760393f0cfadd759a55bde2634bf9c",
    "gfdhfg67": "https://resource.51xf.cn/H5/captcha.html",
    "sdfgd435": "",
    "fghjhg763": "891*1280",
    "ghjkghj5678": "975*1280",
    "fghjnb254": "1084*1728",
    "gfhjfgh567": 74,
    "kghjjh657": "891*1280",
    "wertwer67": true,
    "fgdhfg65": "",
    "wertwer": false,
    "wertdxfgs": "142.0",
    "sdfghtrh": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
    "sdfgfdghjf": "unspecified",
    "hdfghgf": false,
    "gfdsfd675": "saf-captcha",
    "gdfggc": 0,
    "gfdb5456": [
        "PDF Viewer",
        "Chrome PDF Viewer",
        "Chromium PDF Viewer",
        "Microsoft Edge PDF Viewer",
        "WebKit built-in PDF"
    ],
    "asf65445": -480,
    "gfdc6456": "yTeXLp5Hj1xxG4xACv85ZZlC2TJtkZDqFVPOk6wy",
    "hgvh4435": 1786763043739,
    "gdffd98u9": "uGgdcjR3L53iDLFZRQtSDN0Te1fvWIOoRbKwxqrmQL",
    "cxvcx324": 1786763047156,
    "fvcb343": "desktop",
    "xcvbrt454": false,
    "vcxb45": "",
    "bytrre54": "9d4568c009d203ab10e33ea9953a0264",
    "rewtq2354": "99914b932bd37a50b983c5e7c90ae93b",
    "xcvbwre": "5.0 (Macintosh)",
    "cxvczv21eqw": "Mozilla",
    "adfac23": "",
    "zcxv232r4": "",
    "gdfh6574": "",
    "gdfgs23145": 1,
    "h9w87s9": 1,
    "v8w7102": "1786763041986",
    "bgnb89435": "MCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMwIzAjMCMxIzEjMCMwMTExMTEwMDExMTExMTExMTExMTExMTExMQ==",
    "cvxhgftw312": 0,
    "vcvbtryr43": 0,
    "hgdf53425": true,
    "dfasf345": 0,
    "dafs3455d": 1,
    "gfdg3424": 1,
    "fxcv342": 0,
    "xc12": 0,
    "qwergfd32": 0,
    "dfg645": 0,
    "vc234": 0,
    "vv4c234": 0,
    "fd324": 0,
    "cxv324g": 0,
    "nhtret": 0,
    "vbgfx342": 0,
    "dr5435": 0,
    "vcx4321": 0,
    "q9qs8g7": 0,
    "asdjf789": 1,
    "gs8d67g9": -1,
    "as78f5": [],
    "e09baa": "0|0|0|0|0|0|1|1|0|0|0|0|0|0|0|1|1|0|1|1|0|1|1|0|0|0|0|1|1|0|1|1|0",
    "dsfdsf423": 0,
    "abce425": [
        0,
        "a"
    ],
    "sdfsafa234": "",
    "dfsfsdsds123": "",
    "dsfafvccds234": true,
    "rtrsdfsw123": "https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin136.6631b6f8fc5b29744802e183e58e08d501aca2ce1d1c12798f41e16dc50e5f2a.js",
    "jhddgfs234": [
        [
            "https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin136.6631b6f8fc5b29744802e183e58e08d501aca2ce1d1c12798f41e16dc50e5f2a.js",
            188,
            0
        ]
    ],
    "jdhfsgfsdu874": false,
    "ohodshfds23": false,
    "kooxjjzxch1": true,
    "dsjfsdifosd23": false,
    "ofdfshdfsjd454": "",
    "odfhsdhfsdfsdj2": false,
    "kdhfdshfgsdhf": [
        true,
        true,
        true,
        true,
        true
    ],
    "odnfndshsfhdsb3": false,
    "xjxshsadhda467": "",
    "saahxizxh32": [
        0,
        0
    ],
    "oidsngsx321xx": 1,
    "aodhxnjsahs84ndj1": "",
    "bdshuxzasa9801dsd": "",
    "dhxzdahhas32dsds": "",
    "sdjfhdsjh23ds": "https",
    "xzcvcxmn231ds": false,
    "qweqweqwe1231": "c:",
    "kxjvbasd12dvs": "",
    "poiqwermnb231": [
        7723.94,
        7723.94,
        7740.54
    ],
    "zxncbv823jkds": 0,
    "lksdfhj2312dsa": [
        "6e8136ffb71fd50be234f9401dcfa389",
        122,
        110
    ],
    "mnbvxzas8231ds": [
        "1ee71e7302affc7b4d64a3e3e19dc8fd",
        240,
        60
    ],
    "poiqwehjdsa2312": 1,
    "GatherCost": 2882
};

// Values that changed across the two Firefox traces stay per-run.
const nodeCrypto = require_('crypto');
const randomText = length => nodeCrypto.randomBytes(length * 2).toString('base64url').slice(0, length);
const baselinePath = process_.env.FEILIN_BASELINE_JSON;
if (baselinePath) {
    try {
        const baseline = JSON.parse(require_('fs').readFileSync(baselinePath, 'utf8'));
        Object.assign(window._ORDVD_huanj, baseline);
    } catch (e) {
        AsObj.print_('baseline load error: ' + e.message);
    }
}
const runStartMs = Date.now();
// The collector timestamps are per invocation. Keep a separate wall-clock
// anchor for elapsed markers so a fast local run cannot reuse a prior vector.
const collectorStartMs = runStartMs + Math.floor(Math.random() * 17);
const initMs = Number(deviceConfig.timestamp);
const scriptUrl = `https://g.alicdn.com/captcha-frontend/FeiLin/${deviceConfig.version}.js`;
window._ORDVD_huanj.v78d98s = nodeCrypto.randomBytes(8).toString('base64');
window._ORDVD_huanj.ifghjgfhjp = deviceConfig.ip;
window._ORDVD_huanj.nghjdfgsh = '';
window._ORDVD_huanj.dfghfgdh6 = nodeCrypto.randomBytes(25).toString('hex');
window._ORDVD_huanj.gfhjfgh567 = Math.floor(Math.random() * 100);
window._ORDVD_huanj.gfdc6456 = randomText(40);
window._ORDVD_huanj.hgvh4435 = collectorStartMs;
window._ORDVD_huanj.gdffd98u9 = randomText(42);
window._ORDVD_huanj.cxvcx324 = collectorStartMs;
window._ORDVD_huanj.vcxb45 = deviceConfig.certifyId || '';
window._ORDVD_huanj.v8w7102 = String(deviceConfig.timestamp);
window._ORDVD_huanj.rtrsdfsw123 = scriptUrl;
window._ORDVD_huanj.jhddgfs234 = [[scriptUrl, 180 + Math.floor(Math.random() * 20), 0]];
window._ORDVD_huanj.poiqwermnb231 = [performance.now(), performance.now(), performance.now()];
window._ORDVD_huanj.GatherCost = 0;

_ORDVD_huanj_copy = _ORDVD_huanj;
for (let key in _ORDVD_huanj) {
    let value = _ORDVD_huanj[key];
    if (key != 'v78d98s') {
        if (key != 'dfghfgdh6') {
            Object.defineProperty(window._ORDVD_huanj, key, {
                get: function () {
                    return value;
                },
                set: function (value) { }
            })
        }
    }
}

Object.defineProperty(window, '_ORDVD', {
    get: function () {
        debugger
        return window._ORDVD_huanj;
    },
    set: function (value) { 

    }
})


const originalJoin = Array.prototype.join;
Array.prototype.join = function(separator = ', ') {
    if (!Array.isArray(this)) {
        throw new TypeError('this is not an array');
    }
    const joinedString = originalJoin.call(this, separator);
    if (this.length === 10) {
        if (joinedString.length === 50) {
            debugger
            window.dfghfgdh6 = joinedString;
            // AsObj.print_(joinedString)
            // process_.exit(0);
        }
    }
    if (joinedString.indexOf('0|1|1|0|1|1|0"#0') != -1) {
        result = JSON.parse(__ORDVD)
        // result['dfghfgdh6'] = dfghfgdh6;
        // FeiLin005 sends a 127-field projection. rawJoined is a richer
        // diagnostic object (142 fields) and must not be passed downstream.
        const zhiwParts = Array(127).fill('');
        Object.assign(zhiwParts, {
            0: 'W.10054',
            5: 'MacIntel',
            6: 'Firefox',
            7: '142.0',
            21: result['v78d98s'],
            32: '94433880daa9f55b02a5836769d31ee2',
            34: '12',
            36: 'Mac OS',
            37: '10.15',
            42: deviceConfig.ip,
            44: 'true',
            47: '1117*1728',
            49: '0',
            67: 'saf-captcha',
            68: '0',
            75: 'desktop',
            76: 'false',
            78: '9d4568c009d203ab10e33ea9953a0264',
            89: '0',
            90: '0',
            91: 'true'
        });
        const elapsed = Math.max(1, Date.now() - runStartMs);
        const stage = n => Math.max(1, Math.floor(elapsed * n));
        zhiwParts[42] = deviceConfig.ip;
        zhiwParts[43] = `20-${stage(.22)}|23-${stage(.76)}|30-2|40-${stage(.02)}|41-${stage(.73)}|70-${stage(.74)}|71-${stage(.9)}|80-${stage(.9)}|81-${stage(.93)}|93-${stage(2.4)}|94-${stage(2.45)}`;
        zhiwParts[71] = result['gfdc6456'];
        zhiwParts[72] = String(collectorStartMs);
        zhiwParts[73] = result['gdffd98u9'];
        zhiwParts[74] = String(runStartMs + elapsed);
        zhiwParts[77] = deviceConfig.fp2CertifyId || '';
        zhiwParts[87] = String(deviceConfig.timestamp);
        // FeiLin computes the 005 capability bitmap as bgnb89435. It is an
        // environment result, not the unrelated e09baa diagnostic bit list.
        if (typeof result['bgnb89435'] === 'string') {
            zhiwParts[88] = result['bgnb89435'];
        }
        zhiw_ = zhiwParts.join('#');
        AsObj.print_('__FEILIN_RESULT__' + JSON.stringify({
            zhiw: zhiw_,
            gatherCost: elapsed,
            dfg6: typeof window.dfghfgdh6 === 'string' ? window.dfghfgdh6 : '',
            rawResult: result,
            rawJoined: joinedString
        }))
        process_.exit(0);
    }
    return `${joinedString}`;
};
window = watch(window, 'window');
globalThis = watch(globalThis, 'globalThis');
document = watch(document, 'document');
screen = watch(screen, 'screen');
location = watch(location, 'location');
document.all = watch(document.all, 'document.all');
navigator = watch(navigator, 'navigator');
// Firefox: window.chrome is absent.
localStorage = watch(localStorage, 'localStorage');
sessionStorage = watch(sessionStorage, 'sessionStorage');
indexedDB = watch(indexedDB, 'indexedDB');
performance = watch(performance, 'performance');


Window.prototype = watch(Window.prototype, 'Window.prototype');
Document.prototype = watch(Document.prototype, 'Document.prototype');
Navigator.prototype = watch(Navigator.prototype, 'Navigator.prototype');
Location.prototype = watch(Location.prototype, 'Location.prototype');
Screen.prototype = watch(Screen.prototype, 'Screen.prototype');
History.prototype = watch(History.prototype, 'History.prototype');

// deviceConfig = {
//     "key": "d3ffff8e782a4f38",
//     "switch": 1,
//     "sessionId": "ab034ec0643f91399eb33e062dc7fae1-h-1776672563496-823432da5fd94ba390cc0b00f9887624",
//     "version": "1.3.8/feilin019.937455c7df5ca66675ef3e66797c5cc020a8b3c7fdc00c0d22f5f5e14b36b7dd",
//     "pluginElements": "",
//     "pluginResource": "",
//     "globalVariable": "",
//     "timestamp": "1776672563497",
//     "ip": "27.38.173.111"
// };

Ee = {
    "prefix": "1oa2ns",
    "region": "cn",
    "appName": "saf-captcha",
    "appKey": "ab034ec0643f91399eb33e062dc7fae1",
    "endpoints": [
        "https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com",
        "https://cn-shanghai.device.saf.aliyuncs.com"
    ],
    "ENDPOINTS": [
        "https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com",
        "https://cn-shanghai.device.saf.aliyuncs.com"
    ],
    "logs": [
        "10-0",
        "11-853",
        "20-856",
        "23-2200"
    ],
    "initTime": parseInt(deviceConfig['timestamp']) - 338,
    "preCollectData": {
        "fontsNum": 104
    },
    "DeviceConfig": 'byAgDBTTWK6iQ63aLnMRvywYbJ50c453wUz9CdNf4pWB+H4EOu7koqzwbASi1Zy3zgHU8sTKNHpOkNOGqQFYFnvWEtqbKW2d+VVGKvdqNm1ZYMogd5vlHCQE340CuLjqQDcRcBZCbmqmtGoUXOa4w1W0wwhd5rIiFnw/eskOKxI=',
    "deviceConfig": deviceConfig,
    "timestamp": deviceConfig['timestamp'] + '',
    "feilinLoad": true
}
ecx = function (t, r) {
    debugger
}

// Opt-in: wrap crypto-js hashes to log md5 inputs/outputs (dfghfgdh6 attribution).
// Survives feilin's prototype anti-hook because it patches an object property.
if (process_.env.FEILIN_DFG_TRACE) {
    const dfgLog = [];
    const crypt = window.__ALIYUN_CRYPT;
    ['MD5', 'SHA1', 'SHA256', 'SHA512', 'SHA3', 'SHA224', 'SHA384', 'RIPEMD160'].forEach(function (name) {
        const orig = crypt[name];
        if (!orig) return;
        crypt[name] = function (msg, cfg) {
            const r = orig.call(this, msg, cfg);
            try {
                let inp = msg;
                if (msg && msg.toString && msg.words) inp = msg.toString(crypt.enc.Hex) + ' (wordarray)';
                else inp = String(msg);
                dfgLog.push([name, inp.slice(0, 200), r.toString()]);
            } catch (e) {}
            return r;
        };
    });
    process_.on('exit', function () {
        require_('fs').writeFileSync(process_.env.FEILIN_DFG_TRACE,
            dfgLog.map(function (r) { return r.join('\t'); }).join('\n'));
    });
}

require_(process_.env.FEILIN_SCRIPT_PATH || './feilin.js');


window.FEILIN.initFeiLin(Ee, ecx).then((function (t) {
    // AsObj.(t)
    // debugger;
}))
