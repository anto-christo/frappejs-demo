var desk = (function () {
    'use strict';

    var frappejs = {
        async init() {
            if (this._initialized) return;
            this.initConfig();
            this.initGlobals();
            this._initialized = true;
        },

        initConfig() {
            this.config = {
                serverURL: '',
                backend: 'sqlite',
                port: 8000
            };
        },

        initGlobals() {
            this.metaCache = {};
            this.models = {};
            this.forms = {};
            this.views = {};
            this.flags = {};
            this.methods = {};
            // temp params while calling routes
            this.params = {};
        },

        registerLibs(common) {
            // add standard libs and utils to frappe
            common.initLibs(this);
        },

        registerModels(models, type) {
            // register models from app/models/index.js
            const toAdd = Object.assign({}, models.models);

            // post process based on type
            if (models[type]) {
                models[type](toAdd);
            }

            Object.assign(this.models, toAdd);
        },

        registerView(view, name, module) {
            if (!this.views[view]) this.views[view] = {};
            this.views[view][name] = module;
        },

        registerMethod({method, handler}) {
            this.methods[method] = handler;
            if (this.app) {
                // add to router if client-server
                this.app.post(`/api/method/${method}`, this.asyncHandler(async function(request, response) {
                    const data = await handler(request.body);
                    response.json(data);
                }));
            }
        },

        async call({method, args}) {
            if (this.isServer) {
                if (this.methods[method]) {
                    return await this.methods[method](args);
                } else {
                    throw `${method} not found`;
                }
            }

            let url = `/api/method/${method}`;
            let response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(args || {})
            });
            return await response.json();
        },

        addToCache(doc) {
            if (!this.docs) return;

            // add to `docs` cache
            if (doc.doctype && doc.name) {
                if (!this.docs[doc.doctype]) {
                    this.docs[doc.doctype] = {};
                }
                this.docs[doc.doctype][doc.name] = doc;

                // singles available as first level objects too
                if (doc.doctype === doc.name) {
                    this[doc.name] = doc;
                }

                // propogate change to `docs`
                doc.on('change', params => {
                    this.docs.trigger('change', params);
                });
            }
        },

        isDirty(doctype, name) {
            return (this.docs && this.docs[doctype] && this.docs[doctype][name]
                && this.docs[doctype][name]._dirty) || false;
        },

        getDocFromCache(doctype, name) {
            if (this.docs && this.docs[doctype] && this.docs[doctype][name]) {
                return this.docs[doctype][name];
            }
        },

        getMeta(doctype) {
            if (!this.metaCache[doctype]) {
                let model = this.models[doctype];
                if (!model) {
                    throw `${doctype} is not a registered doctype`;
                }
                let metaClass = model.metaClass || this.BaseMeta;
                this.metaCache[doctype] = new metaClass(model);
            }

            return this.metaCache[doctype];
        },

        async getDoc(doctype, name) {
            let doc = this.getDocFromCache(doctype, name);
            if (!doc) {
                doc = new (this.getDocumentClass(doctype))({doctype:doctype, name: name});
                await doc.load();
                this.addToCache(doc);
            }
            return doc;
        },

        getDocumentClass(doctype) {
            const meta = this.getMeta(doctype);
            return meta.documentClass || this.BaseDocument;
        },

        async getSingle(doctype) {
            return await this.getDoc(doctype, doctype);
        },

        async getDuplicate(doc) {
            const newDoc = await this.getNewDoc(doc.doctype);
            for (let field of this.getMeta(doc.doctype).getValidFields()) {
                if (['name', 'submitted'].includes(field.fieldname)) continue;
                if (field.fieldtype === 'Table') {
                    newDoc[field.fieldname] = (doc[field.fieldname] || []).map(d => {
                        let newd = Object.assign({}, d);
                        newd.name = '';
                        return newd;
                    });
                } else {
                    newDoc[field.fieldname] = doc[field.fieldname];
                }
            }
            return newDoc;
        },

        async getNewDoc(doctype) {
            let doc = this.newDoc({doctype: doctype});
            doc._notInserted = true;
            doc.name = this.getRandomString();
            this.addToCache(doc);
            return doc;
        },

        newDoc(data) {
            let doc = new (this.getDocumentClass(data.doctype))(data);
            doc.setDefaults();
            return doc;
        },

        async insert(data) {
            return await (this.newDoc(data)).insert();
        },

        async syncDoc(data) {
            let doc;
            if (await this.db.exists(data.doctype, data.name)) {
                doc = await this.getDoc(data.doctype, data.name);
                Object.assign(doc, data);
                await doc.update();
            } else {
                doc = this.newDoc(data);
                await doc.insert();
            }
        },

        // only for client side
        async login(email, password) {
            if (email === 'Administrator') {
                this.session = {
                    user: 'Administrator'
                };
                return;
            }

            let response = await fetch(this.getServerURL() + '/api/login', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });

            if (response.status === 200) {
                const res = await response.json();

                this.session = {
                    user: email,
                    token: res.token
                };

                return res;
            }

            return response;
        },

        async signup(email, fullName, password) {
            let response = await fetch(this.getServerURL() + '/api/signup', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, fullName, password })
            });

            if (response.status === 200) {
                return await response.json();
            }

            return response;
        },

        getServerURL() {
            return this.config.serverURL || '';
        },

        close() {
            this.db.close();

            if (this.server) {
                this.server.close();
            }
        }
    };

    Array.prototype.equals = function( array ) {
        return this.length == array.length &&
               this.every( function(item,i) { return item == array[i] } );
    };

    var utils = {
        slug(str) {
            return str.replace(/(?:^\w|[A-Z]|\b\w)/g, function(letter, index) {
                return index == 0 ? letter.toLowerCase() : letter.toUpperCase();
            }).replace(/\s+/g, '');
        },

        getRandomString() {
            return Math.random().toString(36).substr(3);
        },

        async sleep(seconds) {
            return new Promise(resolve => {
                setTimeout(resolve, seconds * 1000);
            });
        },

        _(text, args) {
            // should return translated text
            return this.stringReplace(text, args);
        },

        stringReplace(str, args) {
            if (!Array.isArray(args)) {
                args = [args];
            }

            if(str==undefined) return str;

            let unkeyed_index = 0;
            return str.replace(/\{(\w*)\}/g, (match, key) => {
                if (key === '') {
                    key = unkeyed_index;
                    unkeyed_index++;
                }
                if (key == +key) {
                    return args[key] !== undefined
                        ? args[key]
                        : match;
                }
            });
        },

        getQueryString(params) {
            if (!params) return '';
            let parts = [];
            for (let key in params) {
                if (key!=null && params[key]!=null) {
                    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
                }
            }
            return parts.join('&');
        },

        asyncHandler(fn) {
            return (req, res, next) => Promise.resolve(fn(req, res, next))
                .catch((err) => {
                    console.log(err);
                    // handle error
                    res.status(err.status_code || 500).send({error: err.message});
                });
        },

        /**
         * Returns array from 0 to n - 1
         * @param {Number} n
         */
        range(n) {
            return Array.from(Array(4)).map((d, i) => i)
        },

        unique(list, key = it => it) {
            var seen = {};
            return list.filter(item => {
                var k = key(item);
                return seen.hasOwnProperty(k) ? false : (seen[k] = true);
            });
        }
    };

    const number_formats = {
        "#,###.##": { fraction_sep: ".", group_sep: ",", precision: 2 },
        "#.###,##": { fraction_sep: ",", group_sep: ".", precision: 2 },
        "# ###.##": { fraction_sep: ".", group_sep: " ", precision: 2 },
        "# ###,##": { fraction_sep: ",", group_sep: " ", precision: 2 },
        "#'###.##": { fraction_sep: ".", group_sep: "'", precision: 2 },
        "#, ###.##": { fraction_sep: ".", group_sep: ", ", precision: 2 },
        "#,##,###.##": { fraction_sep: ".", group_sep: ",", precision: 2 },
        "#,###.###": { fraction_sep: ".", group_sep: ",", precision: 3 },
        "#.###": { fraction_sep: "", group_sep: ".", precision: 0 },
        "#,###": { fraction_sep: "", group_sep: ",", precision: 0 },
    };

    var number_format = {
        // parse a formatted number string
        // from "4,555,000.34" -> 4555000.34
        parse_number(number, format='#,###.##') {
            if (!number) {
                return 0;
            }
            if (typeof number === 'number') {
                return number;
            }
            const info = this.get_format_info(format);
            return parseFloat(this.remove_separator(number, info.group_sep));
        },

        format_number(number, format = '#,###.##', precision = null) {
            if (!number) {
                number = 0;
            }
            let info = this.get_format_info(format);
            if (precision) {
                info.precision = precision;
            }
            let is_negative = false;

            number = this.parse_number(number);
            if (number < 0) {
                is_negative = true;
            }
            number = Math.abs(number);
            number = number.toFixed(info.precision);

            var parts = number.split('.');

            // get group position and parts
            var group_position = info.group_sep ? 3 : 0;

            if (group_position) {
                var integer = parts[0];
                var str = '';
                var offset = integer.length % group_position;
                for (var i = integer.length; i >= 0; i--) {
                    var l = this.remove_separator(str, info.group_sep).length;
                    if (format == "#,##,###.##" && str.indexOf(",") != -1) { // INR
                        group_position = 2;
                        l += 1;
                    }

                    str += integer.charAt(i);

                    if (l && !((l + 1) % group_position) && i != 0) {
                        str += info.group_sep;
                    }
                }
                parts[0] = str.split("").reverse().join("");
            }
            if (parts[0] + "" == "") {
                parts[0] = "0";
            }

            // join decimal
            parts[1] = (parts[1] && info.fraction_sep) ? (info.fraction_sep + parts[1]) : "";

            // join
            return (is_negative ? "-" : "") + parts[0] + parts[1];
        },

        get_format_info(format) {
            let format_info = number_formats[format];

            if (!format_info) {
                throw `Unknown number format "${format}"`;
            }

            return format_info;
        },

        round(num, precision) {
            var is_negative = num < 0 ? true : false;
            var d = parseInt(precision || 0);
            var m = Math.pow(10, d);
            var n = +(d ? Math.abs(num) * m : Math.abs(num)).toFixed(8); // Avoid rounding errors
            var i = Math.floor(n), f = n - i;
            var r = ((!precision && f == 0.5) ? ((i % 2 == 0) ? i : i + 1) : Math.round(n));
            r = d ? r / m : r;
            return is_negative ? -r : r;
        },

        remove_separator(text, sep) {
            return text.replace(new RegExp(sep === "." ? "\\." : sep, "g"), '');
        }
    };

    var commonjsGlobal = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

    function commonjsRequire () {
    	throw new Error('Dynamic requires are not currently supported by rollup-plugin-commonjs');
    }

    function createCommonjsModule(fn, module) {
    	return module = { exports: {} }, fn(module, module.exports), module.exports;
    }

    var showdown = createCommonjsModule(function (module) {
    (function(){
    /**
     * Created by Tivie on 13-07-2015.
     */

    function getDefaultOpts (simple) {

      var defaultOptions = {
        omitExtraWLInCodeBlocks: {
          defaultValue: false,
          describe: 'Omit the default extra whiteline added to code blocks',
          type: 'boolean'
        },
        noHeaderId: {
          defaultValue: false,
          describe: 'Turn on/off generated header id',
          type: 'boolean'
        },
        prefixHeaderId: {
          defaultValue: false,
          describe: 'Add a prefix to the generated header ids. Passing a string will prefix that string to the header id. Setting to true will add a generic \'section-\' prefix',
          type: 'string'
        },
        rawPrefixHeaderId: {
          defaultValue: false,
          describe: 'Setting this option to true will prevent showdown from modifying the prefix. This might result in malformed IDs (if, for instance, the " char is used in the prefix)',
          type: 'boolean'
        },
        ghCompatibleHeaderId: {
          defaultValue: false,
          describe: 'Generate header ids compatible with github style (spaces are replaced with dashes, a bunch of non alphanumeric chars are removed)',
          type: 'boolean'
        },
        rawHeaderId: {
          defaultValue: false,
          describe: 'Remove only spaces, \' and " from generated header ids (including prefixes), replacing them with dashes (-). WARNING: This might result in malformed ids',
          type: 'boolean'
        },
        headerLevelStart: {
          defaultValue: false,
          describe: 'The header blocks level start',
          type: 'integer'
        },
        parseImgDimensions: {
          defaultValue: false,
          describe: 'Turn on/off image dimension parsing',
          type: 'boolean'
        },
        simplifiedAutoLink: {
          defaultValue: false,
          describe: 'Turn on/off GFM autolink style',
          type: 'boolean'
        },
        excludeTrailingPunctuationFromURLs: {
          defaultValue: false,
          describe: 'Excludes trailing punctuation from links generated with autoLinking',
          type: 'boolean'
        },
        literalMidWordUnderscores: {
          defaultValue: false,
          describe: 'Parse midword underscores as literal underscores',
          type: 'boolean'
        },
        literalMidWordAsterisks: {
          defaultValue: false,
          describe: 'Parse midword asterisks as literal asterisks',
          type: 'boolean'
        },
        strikethrough: {
          defaultValue: false,
          describe: 'Turn on/off strikethrough support',
          type: 'boolean'
        },
        tables: {
          defaultValue: false,
          describe: 'Turn on/off tables support',
          type: 'boolean'
        },
        tablesHeaderId: {
          defaultValue: false,
          describe: 'Add an id to table headers',
          type: 'boolean'
        },
        ghCodeBlocks: {
          defaultValue: true,
          describe: 'Turn on/off GFM fenced code blocks support',
          type: 'boolean'
        },
        tasklists: {
          defaultValue: false,
          describe: 'Turn on/off GFM tasklist support',
          type: 'boolean'
        },
        smoothLivePreview: {
          defaultValue: false,
          describe: 'Prevents weird effects in live previews due to incomplete input',
          type: 'boolean'
        },
        smartIndentationFix: {
          defaultValue: false,
          description: 'Tries to smartly fix indentation in es6 strings',
          type: 'boolean'
        },
        disableForced4SpacesIndentedSublists: {
          defaultValue: false,
          description: 'Disables the requirement of indenting nested sublists by 4 spaces',
          type: 'boolean'
        },
        simpleLineBreaks: {
          defaultValue: false,
          description: 'Parses simple line breaks as <br> (GFM Style)',
          type: 'boolean'
        },
        requireSpaceBeforeHeadingText: {
          defaultValue: false,
          description: 'Makes adding a space between `#` and the header text mandatory (GFM Style)',
          type: 'boolean'
        },
        ghMentions: {
          defaultValue: false,
          description: 'Enables github @mentions',
          type: 'boolean'
        },
        ghMentionsLink: {
          defaultValue: 'https://github.com/{u}',
          description: 'Changes the link generated by @mentions. Only applies if ghMentions option is enabled.',
          type: 'string'
        },
        encodeEmails: {
          defaultValue: true,
          description: 'Encode e-mail addresses through the use of Character Entities, transforming ASCII e-mail addresses into its equivalent decimal entities',
          type: 'boolean'
        },
        openLinksInNewWindow: {
          defaultValue: false,
          description: 'Open all links in new windows',
          type: 'boolean'
        },
        backslashEscapesHTMLTags: {
          defaultValue: false,
          description: 'Support for HTML Tag escaping. ex: \<div>foo\</div>',
          type: 'boolean'
        },
        emoji: {
          defaultValue: false,
          description: 'Enable emoji support. Ex: `this is a :smile: emoji`',
          type: 'boolean'
        },
        underline: {
          defaultValue: false,
          description: 'Enable support for underline. Syntax is double or triple underscores: `__underline word__`. With this option enabled, underscores no longer parses into `<em>` and `<strong>`',
          type: 'boolean'
        },
        completeHTMLDocument: {
          defaultValue: false,
          description: 'Outputs a complete html document, including `<html>`, `<head>` and `<body>` tags',
          type: 'boolean'
        },
        metadata: {
          defaultValue: false,
          description: 'Enable support for document metadata (defined at the top of the document between `«««` and `»»»` or between `---` and `---`).',
          type: 'boolean'
        },
        splitAdjacentBlockquotes: {
          defaultValue: false,
          description: 'Split adjacent blockquote blocks',
          type: 'boolean'
        }
      };
      if (simple === false) {
        return JSON.parse(JSON.stringify(defaultOptions));
      }
      var ret = {};
      for (var opt in defaultOptions) {
        if (defaultOptions.hasOwnProperty(opt)) {
          ret[opt] = defaultOptions[opt].defaultValue;
        }
      }
      return ret;
    }

    function allOptionsOn () {
      var options = getDefaultOpts(true),
          ret = {};
      for (var opt in options) {
        if (options.hasOwnProperty(opt)) {
          ret[opt] = true;
        }
      }
      return ret;
    }

    /**
     * Created by Tivie on 06-01-2015.
     */

    // Private properties
    var showdown = {},
        parsers = {},
        extensions = {},
        globalOptions = getDefaultOpts(true),
        setFlavor = 'vanilla',
        flavor = {
          github: {
            omitExtraWLInCodeBlocks:              true,
            simplifiedAutoLink:                   true,
            excludeTrailingPunctuationFromURLs:   true,
            literalMidWordUnderscores:            true,
            strikethrough:                        true,
            tables:                               true,
            tablesHeaderId:                       true,
            ghCodeBlocks:                         true,
            tasklists:                            true,
            disableForced4SpacesIndentedSublists: true,
            simpleLineBreaks:                     true,
            requireSpaceBeforeHeadingText:        true,
            ghCompatibleHeaderId:                 true,
            ghMentions:                           true,
            backslashEscapesHTMLTags:             true,
            emoji:                                true,
            splitAdjacentBlockquotes:             true
          },
          original: {
            noHeaderId:                           true,
            ghCodeBlocks:                         false
          },
          ghost: {
            omitExtraWLInCodeBlocks:              true,
            parseImgDimensions:                   true,
            simplifiedAutoLink:                   true,
            excludeTrailingPunctuationFromURLs:   true,
            literalMidWordUnderscores:            true,
            strikethrough:                        true,
            tables:                               true,
            tablesHeaderId:                       true,
            ghCodeBlocks:                         true,
            tasklists:                            true,
            smoothLivePreview:                    true,
            simpleLineBreaks:                     true,
            requireSpaceBeforeHeadingText:        true,
            ghMentions:                           false,
            encodeEmails:                         true
          },
          vanilla: getDefaultOpts(true),
          allOn: allOptionsOn()
        };

    /**
     * helper namespace
     * @type {{}}
     */
    showdown.helper = {};

    /**
     * TODO LEGACY SUPPORT CODE
     * @type {{}}
     */
    showdown.extensions = {};

    /**
     * Set a global option
     * @static
     * @param {string} key
     * @param {*} value
     * @returns {showdown}
     */
    showdown.setOption = function (key, value) {
      globalOptions[key] = value;
      return this;
    };

    /**
     * Get a global option
     * @static
     * @param {string} key
     * @returns {*}
     */
    showdown.getOption = function (key) {
      return globalOptions[key];
    };

    /**
     * Get the global options
     * @static
     * @returns {{}}
     */
    showdown.getOptions = function () {
      return globalOptions;
    };

    /**
     * Reset global options to the default values
     * @static
     */
    showdown.resetOptions = function () {
      globalOptions = getDefaultOpts(true);
    };

    /**
     * Set the flavor showdown should use as default
     * @param {string} name
     */
    showdown.setFlavor = function (name) {
      if (!flavor.hasOwnProperty(name)) {
        throw Error(name + ' flavor was not found');
      }
      showdown.resetOptions();
      var preset = flavor[name];
      setFlavor = name;
      for (var option in preset) {
        if (preset.hasOwnProperty(option)) {
          globalOptions[option] = preset[option];
        }
      }
    };

    /**
     * Get the currently set flavor
     * @returns {string}
     */
    showdown.getFlavor = function () {
      return setFlavor;
    };

    /**
     * Get the options of a specified flavor. Returns undefined if the flavor was not found
     * @param {string} name Name of the flavor
     * @returns {{}|undefined}
     */
    showdown.getFlavorOptions = function (name) {
      if (flavor.hasOwnProperty(name)) {
        return flavor[name];
      }
    };

    /**
     * Get the default options
     * @static
     * @param {boolean} [simple=true]
     * @returns {{}}
     */
    showdown.getDefaultOptions = function (simple) {
      return getDefaultOpts(simple);
    };

    /**
     * Get or set a subParser
     *
     * subParser(name)       - Get a registered subParser
     * subParser(name, func) - Register a subParser
     * @static
     * @param {string} name
     * @param {function} [func]
     * @returns {*}
     */
    showdown.subParser = function (name, func) {
      if (showdown.helper.isString(name)) {
        if (typeof func !== 'undefined') {
          parsers[name] = func;
        } else {
          if (parsers.hasOwnProperty(name)) {
            return parsers[name];
          } else {
            throw Error('SubParser named ' + name + ' not registered!');
          }
        }
      }
    };

    /**
     * Gets or registers an extension
     * @static
     * @param {string} name
     * @param {object|function=} ext
     * @returns {*}
     */
    showdown.extension = function (name, ext) {

      if (!showdown.helper.isString(name)) {
        throw Error('Extension \'name\' must be a string');
      }

      name = showdown.helper.stdExtName(name);

      // Getter
      if (showdown.helper.isUndefined(ext)) {
        if (!extensions.hasOwnProperty(name)) {
          throw Error('Extension named ' + name + ' is not registered!');
        }
        return extensions[name];

        // Setter
      } else {
        // Expand extension if it's wrapped in a function
        if (typeof ext === 'function') {
          ext = ext();
        }

        // Ensure extension is an array
        if (!showdown.helper.isArray(ext)) {
          ext = [ext];
        }

        var validExtension = validate(ext, name);

        if (validExtension.valid) {
          extensions[name] = ext;
        } else {
          throw Error(validExtension.error);
        }
      }
    };

    /**
     * Gets all extensions registered
     * @returns {{}}
     */
    showdown.getAllExtensions = function () {
      return extensions;
    };

    /**
     * Remove an extension
     * @param {string} name
     */
    showdown.removeExtension = function (name) {
      delete extensions[name];
    };

    /**
     * Removes all extensions
     */
    showdown.resetExtensions = function () {
      extensions = {};
    };

    /**
     * Validate extension
     * @param {array} extension
     * @param {string} name
     * @returns {{valid: boolean, error: string}}
     */
    function validate (extension, name) {

      var errMsg = (name) ? 'Error in ' + name + ' extension->' : 'Error in unnamed extension',
          ret = {
            valid: true,
            error: ''
          };

      if (!showdown.helper.isArray(extension)) {
        extension = [extension];
      }

      for (var i = 0; i < extension.length; ++i) {
        var baseMsg = errMsg + ' sub-extension ' + i + ': ',
            ext = extension[i];
        if (typeof ext !== 'object') {
          ret.valid = false;
          ret.error = baseMsg + 'must be an object, but ' + typeof ext + ' given';
          return ret;
        }

        if (!showdown.helper.isString(ext.type)) {
          ret.valid = false;
          ret.error = baseMsg + 'property "type" must be a string, but ' + typeof ext.type + ' given';
          return ret;
        }

        var type = ext.type = ext.type.toLowerCase();

        // normalize extension type
        if (type === 'language') {
          type = ext.type = 'lang';
        }

        if (type === 'html') {
          type = ext.type = 'output';
        }

        if (type !== 'lang' && type !== 'output' && type !== 'listener') {
          ret.valid = false;
          ret.error = baseMsg + 'type ' + type + ' is not recognized. Valid values: "lang/language", "output/html" or "listener"';
          return ret;
        }

        if (type === 'listener') {
          if (showdown.helper.isUndefined(ext.listeners)) {
            ret.valid = false;
            ret.error = baseMsg + '. Extensions of type "listener" must have a property called "listeners"';
            return ret;
          }
        } else {
          if (showdown.helper.isUndefined(ext.filter) && showdown.helper.isUndefined(ext.regex)) {
            ret.valid = false;
            ret.error = baseMsg + type + ' extensions must define either a "regex" property or a "filter" method';
            return ret;
          }
        }

        if (ext.listeners) {
          if (typeof ext.listeners !== 'object') {
            ret.valid = false;
            ret.error = baseMsg + '"listeners" property must be an object but ' + typeof ext.listeners + ' given';
            return ret;
          }
          for (var ln in ext.listeners) {
            if (ext.listeners.hasOwnProperty(ln)) {
              if (typeof ext.listeners[ln] !== 'function') {
                ret.valid = false;
                ret.error = baseMsg + '"listeners" property must be an hash of [event name]: [callback]. listeners.' + ln +
                  ' must be a function but ' + typeof ext.listeners[ln] + ' given';
                return ret;
              }
            }
          }
        }

        if (ext.filter) {
          if (typeof ext.filter !== 'function') {
            ret.valid = false;
            ret.error = baseMsg + '"filter" must be a function, but ' + typeof ext.filter + ' given';
            return ret;
          }
        } else if (ext.regex) {
          if (showdown.helper.isString(ext.regex)) {
            ext.regex = new RegExp(ext.regex, 'g');
          }
          if (!(ext.regex instanceof RegExp)) {
            ret.valid = false;
            ret.error = baseMsg + '"regex" property must either be a string or a RegExp object, but ' + typeof ext.regex + ' given';
            return ret;
          }
          if (showdown.helper.isUndefined(ext.replace)) {
            ret.valid = false;
            ret.error = baseMsg + '"regex" extensions must implement a replace string or function';
            return ret;
          }
        }
      }
      return ret;
    }

    /**
     * Validate extension
     * @param {object} ext
     * @returns {boolean}
     */
    showdown.validateExtension = function (ext) {

      var validateExtension = validate(ext, null);
      if (!validateExtension.valid) {
        console.warn(validateExtension.error);
        return false;
      }
      return true;
    };

    /**
     * showdownjs helper functions
     */

    if (!showdown.hasOwnProperty('helper')) {
      showdown.helper = {};
    }

    /**
     * Check if var is string
     * @static
     * @param {string} a
     * @returns {boolean}
     */
    showdown.helper.isString = function (a) {
      return (typeof a === 'string' || a instanceof String);
    };

    /**
     * Check if var is a function
     * @static
     * @param {*} a
     * @returns {boolean}
     */
    showdown.helper.isFunction = function (a) {
      var getType = {};
      return a && getType.toString.call(a) === '[object Function]';
    };

    /**
     * isArray helper function
     * @static
     * @param {*} a
     * @returns {boolean}
     */
    showdown.helper.isArray = function (a) {
      return Array.isArray(a);
    };

    /**
     * Check if value is undefined
     * @static
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is `undefined`, else `false`.
     */
    showdown.helper.isUndefined = function (value) {
      return typeof value === 'undefined';
    };

    /**
     * ForEach helper function
     * Iterates over Arrays and Objects (own properties only)
     * @static
     * @param {*} obj
     * @param {function} callback Accepts 3 params: 1. value, 2. key, 3. the original array/object
     */
    showdown.helper.forEach = function (obj, callback) {
      // check if obj is defined
      if (showdown.helper.isUndefined(obj)) {
        throw new Error('obj param is required');
      }

      if (showdown.helper.isUndefined(callback)) {
        throw new Error('callback param is required');
      }

      if (!showdown.helper.isFunction(callback)) {
        throw new Error('callback param must be a function/closure');
      }

      if (typeof obj.forEach === 'function') {
        obj.forEach(callback);
      } else if (showdown.helper.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) {
          callback(obj[i], i, obj);
        }
      } else if (typeof (obj) === 'object') {
        for (var prop in obj) {
          if (obj.hasOwnProperty(prop)) {
            callback(obj[prop], prop, obj);
          }
        }
      } else {
        throw new Error('obj does not seem to be an array or an iterable object');
      }
    };

    /**
     * Standardidize extension name
     * @static
     * @param {string} s extension name
     * @returns {string}
     */
    showdown.helper.stdExtName = function (s) {
      return s.replace(/[_?*+\/\\.^-]/g, '').replace(/\s/g, '').toLowerCase();
    };

    function escapeCharactersCallback (wholeMatch, m1) {
      var charCodeToEscape = m1.charCodeAt(0);
      return '¨E' + charCodeToEscape + 'E';
    }

    /**
     * Callback used to escape characters when passing through String.replace
     * @static
     * @param {string} wholeMatch
     * @param {string} m1
     * @returns {string}
     */
    showdown.helper.escapeCharactersCallback = escapeCharactersCallback;

    /**
     * Escape characters in a string
     * @static
     * @param {string} text
     * @param {string} charsToEscape
     * @param {boolean} afterBackslash
     * @returns {XML|string|void|*}
     */
    showdown.helper.escapeCharacters = function (text, charsToEscape, afterBackslash) {
      // First we have to escape the escape characters so that
      // we can build a character class out of them
      var regexString = '([' + charsToEscape.replace(/([\[\]\\])/g, '\\$1') + '])';

      if (afterBackslash) {
        regexString = '\\\\' + regexString;
      }

      var regex = new RegExp(regexString, 'g');
      text = text.replace(regex, escapeCharactersCallback);

      return text;
    };

    var rgxFindMatchPos = function (str, left, right, flags) {
      var f = flags || '',
          g = f.indexOf('g') > -1,
          x = new RegExp(left + '|' + right, 'g' + f.replace(/g/g, '')),
          l = new RegExp(left, f.replace(/g/g, '')),
          pos = [],
          t, s, m, start, end;

      do {
        t = 0;
        while ((m = x.exec(str))) {
          if (l.test(m[0])) {
            if (!(t++)) {
              s = x.lastIndex;
              start = s - m[0].length;
            }
          } else if (t) {
            if (!--t) {
              end = m.index + m[0].length;
              var obj = {
                left: {start: start, end: s},
                match: {start: s, end: m.index},
                right: {start: m.index, end: end},
                wholeMatch: {start: start, end: end}
              };
              pos.push(obj);
              if (!g) {
                return pos;
              }
            }
          }
        }
      } while (t && (x.lastIndex = s));

      return pos;
    };

    /**
     * matchRecursiveRegExp
     *
     * (c) 2007 Steven Levithan <stevenlevithan.com>
     * MIT License
     *
     * Accepts a string to search, a left and right format delimiter
     * as regex patterns, and optional regex flags. Returns an array
     * of matches, allowing nested instances of left/right delimiters.
     * Use the "g" flag to return all matches, otherwise only the
     * first is returned. Be careful to ensure that the left and
     * right format delimiters produce mutually exclusive matches.
     * Backreferences are not supported within the right delimiter
     * due to how it is internally combined with the left delimiter.
     * When matching strings whose format delimiters are unbalanced
     * to the left or right, the output is intentionally as a
     * conventional regex library with recursion support would
     * produce, e.g. "<<x>" and "<x>>" both produce ["x"] when using
     * "<" and ">" as the delimiters (both strings contain a single,
     * balanced instance of "<x>").
     *
     * examples:
     * matchRecursiveRegExp("test", "\\(", "\\)")
     * returns: []
     * matchRecursiveRegExp("<t<<e>><s>>t<>", "<", ">", "g")
     * returns: ["t<<e>><s>", ""]
     * matchRecursiveRegExp("<div id=\"x\">test</div>", "<div\\b[^>]*>", "</div>", "gi")
     * returns: ["test"]
     */
    showdown.helper.matchRecursiveRegExp = function (str, left, right, flags) {

      var matchPos = rgxFindMatchPos (str, left, right, flags),
          results = [];

      for (var i = 0; i < matchPos.length; ++i) {
        results.push([
          str.slice(matchPos[i].wholeMatch.start, matchPos[i].wholeMatch.end),
          str.slice(matchPos[i].match.start, matchPos[i].match.end),
          str.slice(matchPos[i].left.start, matchPos[i].left.end),
          str.slice(matchPos[i].right.start, matchPos[i].right.end)
        ]);
      }
      return results;
    };

    /**
     *
     * @param {string} str
     * @param {string|function} replacement
     * @param {string} left
     * @param {string} right
     * @param {string} flags
     * @returns {string}
     */
    showdown.helper.replaceRecursiveRegExp = function (str, replacement, left, right, flags) {

      if (!showdown.helper.isFunction(replacement)) {
        var repStr = replacement;
        replacement = function () {
          return repStr;
        };
      }

      var matchPos = rgxFindMatchPos(str, left, right, flags),
          finalStr = str,
          lng = matchPos.length;

      if (lng > 0) {
        var bits = [];
        if (matchPos[0].wholeMatch.start !== 0) {
          bits.push(str.slice(0, matchPos[0].wholeMatch.start));
        }
        for (var i = 0; i < lng; ++i) {
          bits.push(
            replacement(
              str.slice(matchPos[i].wholeMatch.start, matchPos[i].wholeMatch.end),
              str.slice(matchPos[i].match.start, matchPos[i].match.end),
              str.slice(matchPos[i].left.start, matchPos[i].left.end),
              str.slice(matchPos[i].right.start, matchPos[i].right.end)
            )
          );
          if (i < lng - 1) {
            bits.push(str.slice(matchPos[i].wholeMatch.end, matchPos[i + 1].wholeMatch.start));
          }
        }
        if (matchPos[lng - 1].wholeMatch.end < str.length) {
          bits.push(str.slice(matchPos[lng - 1].wholeMatch.end));
        }
        finalStr = bits.join('');
      }
      return finalStr;
    };

    /**
     * Returns the index within the passed String object of the first occurrence of the specified regex,
     * starting the search at fromIndex. Returns -1 if the value is not found.
     *
     * @param {string} str string to search
     * @param {RegExp} regex Regular expression to search
     * @param {int} [fromIndex = 0] Index to start the search
     * @returns {Number}
     * @throws InvalidArgumentError
     */
    showdown.helper.regexIndexOf = function (str, regex, fromIndex) {
      if (!showdown.helper.isString(str)) {
        throw 'InvalidArgumentError: first parameter of showdown.helper.regexIndexOf function must be a string';
      }
      if (regex instanceof RegExp === false) {
        throw 'InvalidArgumentError: second parameter of showdown.helper.regexIndexOf function must be an instance of RegExp';
      }
      var indexOf = str.substring(fromIndex || 0).search(regex);
      return (indexOf >= 0) ? (indexOf + (fromIndex || 0)) : indexOf;
    };

    /**
     * Splits the passed string object at the defined index, and returns an array composed of the two substrings
     * @param {string} str string to split
     * @param {int} index index to split string at
     * @returns {[string,string]}
     * @throws InvalidArgumentError
     */
    showdown.helper.splitAtIndex = function (str, index) {
      if (!showdown.helper.isString(str)) {
        throw 'InvalidArgumentError: first parameter of showdown.helper.regexIndexOf function must be a string';
      }
      return [str.substring(0, index), str.substring(index)];
    };

    /**
     * Obfuscate an e-mail address through the use of Character Entities,
     * transforming ASCII characters into their equivalent decimal or hex entities.
     *
     * Since it has a random component, subsequent calls to this function produce different results
     *
     * @param {string} mail
     * @returns {string}
     */
    showdown.helper.encodeEmailAddress = function (mail) {
      var encode = [
        function (ch) {
          return '&#' + ch.charCodeAt(0) + ';';
        },
        function (ch) {
          return '&#x' + ch.charCodeAt(0).toString(16) + ';';
        },
        function (ch) {
          return ch;
        }
      ];

      mail = mail.replace(/./g, function (ch) {
        if (ch === '@') {
          // this *must* be encoded. I insist.
          ch = encode[Math.floor(Math.random() * 2)](ch);
        } else {
          var r = Math.random();
          // roughly 10% raw, 45% hex, 45% dec
          ch = (
            r > 0.9 ? encode[2](ch) : r > 0.45 ? encode[1](ch) : encode[0](ch)
          );
        }
        return ch;
      });

      return mail;
    };

    /**
     * POLYFILLS
     */
    // use this instead of builtin is undefined for IE8 compatibility
    if (typeof(console) === 'undefined') {
      console = {
        warn: function (msg) {
          alert(msg);
        },
        log: function (msg) {
          alert(msg);
        },
        error: function (msg) {
          throw msg;
        }
      };
    }

    /**
     * Common regexes.
     * We declare some common regexes to improve performance
     */
    showdown.helper.regexes = {
      asteriskDashAndColon: /([*_:~])/g
    };

    /**
     * EMOJIS LIST
     */
    showdown.helper.emojis = {
      '+1':'\ud83d\udc4d',
      '-1':'\ud83d\udc4e',
      '100':'\ud83d\udcaf',
      '1234':'\ud83d\udd22',
      '1st_place_medal':'\ud83e\udd47',
      '2nd_place_medal':'\ud83e\udd48',
      '3rd_place_medal':'\ud83e\udd49',
      '8ball':'\ud83c\udfb1',
      'a':'\ud83c\udd70\ufe0f',
      'ab':'\ud83c\udd8e',
      'abc':'\ud83d\udd24',
      'abcd':'\ud83d\udd21',
      'accept':'\ud83c\ude51',
      'aerial_tramway':'\ud83d\udea1',
      'airplane':'\u2708\ufe0f',
      'alarm_clock':'\u23f0',
      'alembic':'\u2697\ufe0f',
      'alien':'\ud83d\udc7d',
      'ambulance':'\ud83d\ude91',
      'amphora':'\ud83c\udffa',
      'anchor':'\u2693\ufe0f',
      'angel':'\ud83d\udc7c',
      'anger':'\ud83d\udca2',
      'angry':'\ud83d\ude20',
      'anguished':'\ud83d\ude27',
      'ant':'\ud83d\udc1c',
      'apple':'\ud83c\udf4e',
      'aquarius':'\u2652\ufe0f',
      'aries':'\u2648\ufe0f',
      'arrow_backward':'\u25c0\ufe0f',
      'arrow_double_down':'\u23ec',
      'arrow_double_up':'\u23eb',
      'arrow_down':'\u2b07\ufe0f',
      'arrow_down_small':'\ud83d\udd3d',
      'arrow_forward':'\u25b6\ufe0f',
      'arrow_heading_down':'\u2935\ufe0f',
      'arrow_heading_up':'\u2934\ufe0f',
      'arrow_left':'\u2b05\ufe0f',
      'arrow_lower_left':'\u2199\ufe0f',
      'arrow_lower_right':'\u2198\ufe0f',
      'arrow_right':'\u27a1\ufe0f',
      'arrow_right_hook':'\u21aa\ufe0f',
      'arrow_up':'\u2b06\ufe0f',
      'arrow_up_down':'\u2195\ufe0f',
      'arrow_up_small':'\ud83d\udd3c',
      'arrow_upper_left':'\u2196\ufe0f',
      'arrow_upper_right':'\u2197\ufe0f',
      'arrows_clockwise':'\ud83d\udd03',
      'arrows_counterclockwise':'\ud83d\udd04',
      'art':'\ud83c\udfa8',
      'articulated_lorry':'\ud83d\ude9b',
      'artificial_satellite':'\ud83d\udef0',
      'astonished':'\ud83d\ude32',
      'athletic_shoe':'\ud83d\udc5f',
      'atm':'\ud83c\udfe7',
      'atom_symbol':'\u269b\ufe0f',
      'avocado':'\ud83e\udd51',
      'b':'\ud83c\udd71\ufe0f',
      'baby':'\ud83d\udc76',
      'baby_bottle':'\ud83c\udf7c',
      'baby_chick':'\ud83d\udc24',
      'baby_symbol':'\ud83d\udebc',
      'back':'\ud83d\udd19',
      'bacon':'\ud83e\udd53',
      'badminton':'\ud83c\udff8',
      'baggage_claim':'\ud83d\udec4',
      'baguette_bread':'\ud83e\udd56',
      'balance_scale':'\u2696\ufe0f',
      'balloon':'\ud83c\udf88',
      'ballot_box':'\ud83d\uddf3',
      'ballot_box_with_check':'\u2611\ufe0f',
      'bamboo':'\ud83c\udf8d',
      'banana':'\ud83c\udf4c',
      'bangbang':'\u203c\ufe0f',
      'bank':'\ud83c\udfe6',
      'bar_chart':'\ud83d\udcca',
      'barber':'\ud83d\udc88',
      'baseball':'\u26be\ufe0f',
      'basketball':'\ud83c\udfc0',
      'basketball_man':'\u26f9\ufe0f',
      'basketball_woman':'\u26f9\ufe0f&zwj;\u2640\ufe0f',
      'bat':'\ud83e\udd87',
      'bath':'\ud83d\udec0',
      'bathtub':'\ud83d\udec1',
      'battery':'\ud83d\udd0b',
      'beach_umbrella':'\ud83c\udfd6',
      'bear':'\ud83d\udc3b',
      'bed':'\ud83d\udecf',
      'bee':'\ud83d\udc1d',
      'beer':'\ud83c\udf7a',
      'beers':'\ud83c\udf7b',
      'beetle':'\ud83d\udc1e',
      'beginner':'\ud83d\udd30',
      'bell':'\ud83d\udd14',
      'bellhop_bell':'\ud83d\udece',
      'bento':'\ud83c\udf71',
      'biking_man':'\ud83d\udeb4',
      'bike':'\ud83d\udeb2',
      'biking_woman':'\ud83d\udeb4&zwj;\u2640\ufe0f',
      'bikini':'\ud83d\udc59',
      'biohazard':'\u2623\ufe0f',
      'bird':'\ud83d\udc26',
      'birthday':'\ud83c\udf82',
      'black_circle':'\u26ab\ufe0f',
      'black_flag':'\ud83c\udff4',
      'black_heart':'\ud83d\udda4',
      'black_joker':'\ud83c\udccf',
      'black_large_square':'\u2b1b\ufe0f',
      'black_medium_small_square':'\u25fe\ufe0f',
      'black_medium_square':'\u25fc\ufe0f',
      'black_nib':'\u2712\ufe0f',
      'black_small_square':'\u25aa\ufe0f',
      'black_square_button':'\ud83d\udd32',
      'blonde_man':'\ud83d\udc71',
      'blonde_woman':'\ud83d\udc71&zwj;\u2640\ufe0f',
      'blossom':'\ud83c\udf3c',
      'blowfish':'\ud83d\udc21',
      'blue_book':'\ud83d\udcd8',
      'blue_car':'\ud83d\ude99',
      'blue_heart':'\ud83d\udc99',
      'blush':'\ud83d\ude0a',
      'boar':'\ud83d\udc17',
      'boat':'\u26f5\ufe0f',
      'bomb':'\ud83d\udca3',
      'book':'\ud83d\udcd6',
      'bookmark':'\ud83d\udd16',
      'bookmark_tabs':'\ud83d\udcd1',
      'books':'\ud83d\udcda',
      'boom':'\ud83d\udca5',
      'boot':'\ud83d\udc62',
      'bouquet':'\ud83d\udc90',
      'bowing_man':'\ud83d\ude47',
      'bow_and_arrow':'\ud83c\udff9',
      'bowing_woman':'\ud83d\ude47&zwj;\u2640\ufe0f',
      'bowling':'\ud83c\udfb3',
      'boxing_glove':'\ud83e\udd4a',
      'boy':'\ud83d\udc66',
      'bread':'\ud83c\udf5e',
      'bride_with_veil':'\ud83d\udc70',
      'bridge_at_night':'\ud83c\udf09',
      'briefcase':'\ud83d\udcbc',
      'broken_heart':'\ud83d\udc94',
      'bug':'\ud83d\udc1b',
      'building_construction':'\ud83c\udfd7',
      'bulb':'\ud83d\udca1',
      'bullettrain_front':'\ud83d\ude85',
      'bullettrain_side':'\ud83d\ude84',
      'burrito':'\ud83c\udf2f',
      'bus':'\ud83d\ude8c',
      'business_suit_levitating':'\ud83d\udd74',
      'busstop':'\ud83d\ude8f',
      'bust_in_silhouette':'\ud83d\udc64',
      'busts_in_silhouette':'\ud83d\udc65',
      'butterfly':'\ud83e\udd8b',
      'cactus':'\ud83c\udf35',
      'cake':'\ud83c\udf70',
      'calendar':'\ud83d\udcc6',
      'call_me_hand':'\ud83e\udd19',
      'calling':'\ud83d\udcf2',
      'camel':'\ud83d\udc2b',
      'camera':'\ud83d\udcf7',
      'camera_flash':'\ud83d\udcf8',
      'camping':'\ud83c\udfd5',
      'cancer':'\u264b\ufe0f',
      'candle':'\ud83d\udd6f',
      'candy':'\ud83c\udf6c',
      'canoe':'\ud83d\udef6',
      'capital_abcd':'\ud83d\udd20',
      'capricorn':'\u2651\ufe0f',
      'car':'\ud83d\ude97',
      'card_file_box':'\ud83d\uddc3',
      'card_index':'\ud83d\udcc7',
      'card_index_dividers':'\ud83d\uddc2',
      'carousel_horse':'\ud83c\udfa0',
      'carrot':'\ud83e\udd55',
      'cat':'\ud83d\udc31',
      'cat2':'\ud83d\udc08',
      'cd':'\ud83d\udcbf',
      'chains':'\u26d3',
      'champagne':'\ud83c\udf7e',
      'chart':'\ud83d\udcb9',
      'chart_with_downwards_trend':'\ud83d\udcc9',
      'chart_with_upwards_trend':'\ud83d\udcc8',
      'checkered_flag':'\ud83c\udfc1',
      'cheese':'\ud83e\uddc0',
      'cherries':'\ud83c\udf52',
      'cherry_blossom':'\ud83c\udf38',
      'chestnut':'\ud83c\udf30',
      'chicken':'\ud83d\udc14',
      'children_crossing':'\ud83d\udeb8',
      'chipmunk':'\ud83d\udc3f',
      'chocolate_bar':'\ud83c\udf6b',
      'christmas_tree':'\ud83c\udf84',
      'church':'\u26ea\ufe0f',
      'cinema':'\ud83c\udfa6',
      'circus_tent':'\ud83c\udfaa',
      'city_sunrise':'\ud83c\udf07',
      'city_sunset':'\ud83c\udf06',
      'cityscape':'\ud83c\udfd9',
      'cl':'\ud83c\udd91',
      'clamp':'\ud83d\udddc',
      'clap':'\ud83d\udc4f',
      'clapper':'\ud83c\udfac',
      'classical_building':'\ud83c\udfdb',
      'clinking_glasses':'\ud83e\udd42',
      'clipboard':'\ud83d\udccb',
      'clock1':'\ud83d\udd50',
      'clock10':'\ud83d\udd59',
      'clock1030':'\ud83d\udd65',
      'clock11':'\ud83d\udd5a',
      'clock1130':'\ud83d\udd66',
      'clock12':'\ud83d\udd5b',
      'clock1230':'\ud83d\udd67',
      'clock130':'\ud83d\udd5c',
      'clock2':'\ud83d\udd51',
      'clock230':'\ud83d\udd5d',
      'clock3':'\ud83d\udd52',
      'clock330':'\ud83d\udd5e',
      'clock4':'\ud83d\udd53',
      'clock430':'\ud83d\udd5f',
      'clock5':'\ud83d\udd54',
      'clock530':'\ud83d\udd60',
      'clock6':'\ud83d\udd55',
      'clock630':'\ud83d\udd61',
      'clock7':'\ud83d\udd56',
      'clock730':'\ud83d\udd62',
      'clock8':'\ud83d\udd57',
      'clock830':'\ud83d\udd63',
      'clock9':'\ud83d\udd58',
      'clock930':'\ud83d\udd64',
      'closed_book':'\ud83d\udcd5',
      'closed_lock_with_key':'\ud83d\udd10',
      'closed_umbrella':'\ud83c\udf02',
      'cloud':'\u2601\ufe0f',
      'cloud_with_lightning':'\ud83c\udf29',
      'cloud_with_lightning_and_rain':'\u26c8',
      'cloud_with_rain':'\ud83c\udf27',
      'cloud_with_snow':'\ud83c\udf28',
      'clown_face':'\ud83e\udd21',
      'clubs':'\u2663\ufe0f',
      'cocktail':'\ud83c\udf78',
      'coffee':'\u2615\ufe0f',
      'coffin':'\u26b0\ufe0f',
      'cold_sweat':'\ud83d\ude30',
      'comet':'\u2604\ufe0f',
      'computer':'\ud83d\udcbb',
      'computer_mouse':'\ud83d\uddb1',
      'confetti_ball':'\ud83c\udf8a',
      'confounded':'\ud83d\ude16',
      'confused':'\ud83d\ude15',
      'congratulations':'\u3297\ufe0f',
      'construction':'\ud83d\udea7',
      'construction_worker_man':'\ud83d\udc77',
      'construction_worker_woman':'\ud83d\udc77&zwj;\u2640\ufe0f',
      'control_knobs':'\ud83c\udf9b',
      'convenience_store':'\ud83c\udfea',
      'cookie':'\ud83c\udf6a',
      'cool':'\ud83c\udd92',
      'policeman':'\ud83d\udc6e',
      'copyright':'\u00a9\ufe0f',
      'corn':'\ud83c\udf3d',
      'couch_and_lamp':'\ud83d\udecb',
      'couple':'\ud83d\udc6b',
      'couple_with_heart_woman_man':'\ud83d\udc91',
      'couple_with_heart_man_man':'\ud83d\udc68&zwj;\u2764\ufe0f&zwj;\ud83d\udc68',
      'couple_with_heart_woman_woman':'\ud83d\udc69&zwj;\u2764\ufe0f&zwj;\ud83d\udc69',
      'couplekiss_man_man':'\ud83d\udc68&zwj;\u2764\ufe0f&zwj;\ud83d\udc8b&zwj;\ud83d\udc68',
      'couplekiss_man_woman':'\ud83d\udc8f',
      'couplekiss_woman_woman':'\ud83d\udc69&zwj;\u2764\ufe0f&zwj;\ud83d\udc8b&zwj;\ud83d\udc69',
      'cow':'\ud83d\udc2e',
      'cow2':'\ud83d\udc04',
      'cowboy_hat_face':'\ud83e\udd20',
      'crab':'\ud83e\udd80',
      'crayon':'\ud83d\udd8d',
      'credit_card':'\ud83d\udcb3',
      'crescent_moon':'\ud83c\udf19',
      'cricket':'\ud83c\udfcf',
      'crocodile':'\ud83d\udc0a',
      'croissant':'\ud83e\udd50',
      'crossed_fingers':'\ud83e\udd1e',
      'crossed_flags':'\ud83c\udf8c',
      'crossed_swords':'\u2694\ufe0f',
      'crown':'\ud83d\udc51',
      'cry':'\ud83d\ude22',
      'crying_cat_face':'\ud83d\ude3f',
      'crystal_ball':'\ud83d\udd2e',
      'cucumber':'\ud83e\udd52',
      'cupid':'\ud83d\udc98',
      'curly_loop':'\u27b0',
      'currency_exchange':'\ud83d\udcb1',
      'curry':'\ud83c\udf5b',
      'custard':'\ud83c\udf6e',
      'customs':'\ud83d\udec3',
      'cyclone':'\ud83c\udf00',
      'dagger':'\ud83d\udde1',
      'dancer':'\ud83d\udc83',
      'dancing_women':'\ud83d\udc6f',
      'dancing_men':'\ud83d\udc6f&zwj;\u2642\ufe0f',
      'dango':'\ud83c\udf61',
      'dark_sunglasses':'\ud83d\udd76',
      'dart':'\ud83c\udfaf',
      'dash':'\ud83d\udca8',
      'date':'\ud83d\udcc5',
      'deciduous_tree':'\ud83c\udf33',
      'deer':'\ud83e\udd8c',
      'department_store':'\ud83c\udfec',
      'derelict_house':'\ud83c\udfda',
      'desert':'\ud83c\udfdc',
      'desert_island':'\ud83c\udfdd',
      'desktop_computer':'\ud83d\udda5',
      'male_detective':'\ud83d\udd75\ufe0f',
      'diamond_shape_with_a_dot_inside':'\ud83d\udca0',
      'diamonds':'\u2666\ufe0f',
      'disappointed':'\ud83d\ude1e',
      'disappointed_relieved':'\ud83d\ude25',
      'dizzy':'\ud83d\udcab',
      'dizzy_face':'\ud83d\ude35',
      'do_not_litter':'\ud83d\udeaf',
      'dog':'\ud83d\udc36',
      'dog2':'\ud83d\udc15',
      'dollar':'\ud83d\udcb5',
      'dolls':'\ud83c\udf8e',
      'dolphin':'\ud83d\udc2c',
      'door':'\ud83d\udeaa',
      'doughnut':'\ud83c\udf69',
      'dove':'\ud83d\udd4a',
      'dragon':'\ud83d\udc09',
      'dragon_face':'\ud83d\udc32',
      'dress':'\ud83d\udc57',
      'dromedary_camel':'\ud83d\udc2a',
      'drooling_face':'\ud83e\udd24',
      'droplet':'\ud83d\udca7',
      'drum':'\ud83e\udd41',
      'duck':'\ud83e\udd86',
      'dvd':'\ud83d\udcc0',
      'e-mail':'\ud83d\udce7',
      'eagle':'\ud83e\udd85',
      'ear':'\ud83d\udc42',
      'ear_of_rice':'\ud83c\udf3e',
      'earth_africa':'\ud83c\udf0d',
      'earth_americas':'\ud83c\udf0e',
      'earth_asia':'\ud83c\udf0f',
      'egg':'\ud83e\udd5a',
      'eggplant':'\ud83c\udf46',
      'eight_pointed_black_star':'\u2734\ufe0f',
      'eight_spoked_asterisk':'\u2733\ufe0f',
      'electric_plug':'\ud83d\udd0c',
      'elephant':'\ud83d\udc18',
      'email':'\u2709\ufe0f',
      'end':'\ud83d\udd1a',
      'envelope_with_arrow':'\ud83d\udce9',
      'euro':'\ud83d\udcb6',
      'european_castle':'\ud83c\udff0',
      'european_post_office':'\ud83c\udfe4',
      'evergreen_tree':'\ud83c\udf32',
      'exclamation':'\u2757\ufe0f',
      'expressionless':'\ud83d\ude11',
      'eye':'\ud83d\udc41',
      'eye_speech_bubble':'\ud83d\udc41&zwj;\ud83d\udde8',
      'eyeglasses':'\ud83d\udc53',
      'eyes':'\ud83d\udc40',
      'face_with_head_bandage':'\ud83e\udd15',
      'face_with_thermometer':'\ud83e\udd12',
      'fist_oncoming':'\ud83d\udc4a',
      'factory':'\ud83c\udfed',
      'fallen_leaf':'\ud83c\udf42',
      'family_man_woman_boy':'\ud83d\udc6a',
      'family_man_boy':'\ud83d\udc68&zwj;\ud83d\udc66',
      'family_man_boy_boy':'\ud83d\udc68&zwj;\ud83d\udc66&zwj;\ud83d\udc66',
      'family_man_girl':'\ud83d\udc68&zwj;\ud83d\udc67',
      'family_man_girl_boy':'\ud83d\udc68&zwj;\ud83d\udc67&zwj;\ud83d\udc66',
      'family_man_girl_girl':'\ud83d\udc68&zwj;\ud83d\udc67&zwj;\ud83d\udc67',
      'family_man_man_boy':'\ud83d\udc68&zwj;\ud83d\udc68&zwj;\ud83d\udc66',
      'family_man_man_boy_boy':'\ud83d\udc68&zwj;\ud83d\udc68&zwj;\ud83d\udc66&zwj;\ud83d\udc66',
      'family_man_man_girl':'\ud83d\udc68&zwj;\ud83d\udc68&zwj;\ud83d\udc67',
      'family_man_man_girl_boy':'\ud83d\udc68&zwj;\ud83d\udc68&zwj;\ud83d\udc67&zwj;\ud83d\udc66',
      'family_man_man_girl_girl':'\ud83d\udc68&zwj;\ud83d\udc68&zwj;\ud83d\udc67&zwj;\ud83d\udc67',
      'family_man_woman_boy_boy':'\ud83d\udc68&zwj;\ud83d\udc69&zwj;\ud83d\udc66&zwj;\ud83d\udc66',
      'family_man_woman_girl':'\ud83d\udc68&zwj;\ud83d\udc69&zwj;\ud83d\udc67',
      'family_man_woman_girl_boy':'\ud83d\udc68&zwj;\ud83d\udc69&zwj;\ud83d\udc67&zwj;\ud83d\udc66',
      'family_man_woman_girl_girl':'\ud83d\udc68&zwj;\ud83d\udc69&zwj;\ud83d\udc67&zwj;\ud83d\udc67',
      'family_woman_boy':'\ud83d\udc69&zwj;\ud83d\udc66',
      'family_woman_boy_boy':'\ud83d\udc69&zwj;\ud83d\udc66&zwj;\ud83d\udc66',
      'family_woman_girl':'\ud83d\udc69&zwj;\ud83d\udc67',
      'family_woman_girl_boy':'\ud83d\udc69&zwj;\ud83d\udc67&zwj;\ud83d\udc66',
      'family_woman_girl_girl':'\ud83d\udc69&zwj;\ud83d\udc67&zwj;\ud83d\udc67',
      'family_woman_woman_boy':'\ud83d\udc69&zwj;\ud83d\udc69&zwj;\ud83d\udc66',
      'family_woman_woman_boy_boy':'\ud83d\udc69&zwj;\ud83d\udc69&zwj;\ud83d\udc66&zwj;\ud83d\udc66',
      'family_woman_woman_girl':'\ud83d\udc69&zwj;\ud83d\udc69&zwj;\ud83d\udc67',
      'family_woman_woman_girl_boy':'\ud83d\udc69&zwj;\ud83d\udc69&zwj;\ud83d\udc67&zwj;\ud83d\udc66',
      'family_woman_woman_girl_girl':'\ud83d\udc69&zwj;\ud83d\udc69&zwj;\ud83d\udc67&zwj;\ud83d\udc67',
      'fast_forward':'\u23e9',
      'fax':'\ud83d\udce0',
      'fearful':'\ud83d\ude28',
      'feet':'\ud83d\udc3e',
      'female_detective':'\ud83d\udd75\ufe0f&zwj;\u2640\ufe0f',
      'ferris_wheel':'\ud83c\udfa1',
      'ferry':'\u26f4',
      'field_hockey':'\ud83c\udfd1',
      'file_cabinet':'\ud83d\uddc4',
      'file_folder':'\ud83d\udcc1',
      'film_projector':'\ud83d\udcfd',
      'film_strip':'\ud83c\udf9e',
      'fire':'\ud83d\udd25',
      'fire_engine':'\ud83d\ude92',
      'fireworks':'\ud83c\udf86',
      'first_quarter_moon':'\ud83c\udf13',
      'first_quarter_moon_with_face':'\ud83c\udf1b',
      'fish':'\ud83d\udc1f',
      'fish_cake':'\ud83c\udf65',
      'fishing_pole_and_fish':'\ud83c\udfa3',
      'fist_raised':'\u270a',
      'fist_left':'\ud83e\udd1b',
      'fist_right':'\ud83e\udd1c',
      'flags':'\ud83c\udf8f',
      'flashlight':'\ud83d\udd26',
      'fleur_de_lis':'\u269c\ufe0f',
      'flight_arrival':'\ud83d\udeec',
      'flight_departure':'\ud83d\udeeb',
      'floppy_disk':'\ud83d\udcbe',
      'flower_playing_cards':'\ud83c\udfb4',
      'flushed':'\ud83d\ude33',
      'fog':'\ud83c\udf2b',
      'foggy':'\ud83c\udf01',
      'football':'\ud83c\udfc8',
      'footprints':'\ud83d\udc63',
      'fork_and_knife':'\ud83c\udf74',
      'fountain':'\u26f2\ufe0f',
      'fountain_pen':'\ud83d\udd8b',
      'four_leaf_clover':'\ud83c\udf40',
      'fox_face':'\ud83e\udd8a',
      'framed_picture':'\ud83d\uddbc',
      'free':'\ud83c\udd93',
      'fried_egg':'\ud83c\udf73',
      'fried_shrimp':'\ud83c\udf64',
      'fries':'\ud83c\udf5f',
      'frog':'\ud83d\udc38',
      'frowning':'\ud83d\ude26',
      'frowning_face':'\u2639\ufe0f',
      'frowning_man':'\ud83d\ude4d&zwj;\u2642\ufe0f',
      'frowning_woman':'\ud83d\ude4d',
      'middle_finger':'\ud83d\udd95',
      'fuelpump':'\u26fd\ufe0f',
      'full_moon':'\ud83c\udf15',
      'full_moon_with_face':'\ud83c\udf1d',
      'funeral_urn':'\u26b1\ufe0f',
      'game_die':'\ud83c\udfb2',
      'gear':'\u2699\ufe0f',
      'gem':'\ud83d\udc8e',
      'gemini':'\u264a\ufe0f',
      'ghost':'\ud83d\udc7b',
      'gift':'\ud83c\udf81',
      'gift_heart':'\ud83d\udc9d',
      'girl':'\ud83d\udc67',
      'globe_with_meridians':'\ud83c\udf10',
      'goal_net':'\ud83e\udd45',
      'goat':'\ud83d\udc10',
      'golf':'\u26f3\ufe0f',
      'golfing_man':'\ud83c\udfcc\ufe0f',
      'golfing_woman':'\ud83c\udfcc\ufe0f&zwj;\u2640\ufe0f',
      'gorilla':'\ud83e\udd8d',
      'grapes':'\ud83c\udf47',
      'green_apple':'\ud83c\udf4f',
      'green_book':'\ud83d\udcd7',
      'green_heart':'\ud83d\udc9a',
      'green_salad':'\ud83e\udd57',
      'grey_exclamation':'\u2755',
      'grey_question':'\u2754',
      'grimacing':'\ud83d\ude2c',
      'grin':'\ud83d\ude01',
      'grinning':'\ud83d\ude00',
      'guardsman':'\ud83d\udc82',
      'guardswoman':'\ud83d\udc82&zwj;\u2640\ufe0f',
      'guitar':'\ud83c\udfb8',
      'gun':'\ud83d\udd2b',
      'haircut_woman':'\ud83d\udc87',
      'haircut_man':'\ud83d\udc87&zwj;\u2642\ufe0f',
      'hamburger':'\ud83c\udf54',
      'hammer':'\ud83d\udd28',
      'hammer_and_pick':'\u2692',
      'hammer_and_wrench':'\ud83d\udee0',
      'hamster':'\ud83d\udc39',
      'hand':'\u270b',
      'handbag':'\ud83d\udc5c',
      'handshake':'\ud83e\udd1d',
      'hankey':'\ud83d\udca9',
      'hatched_chick':'\ud83d\udc25',
      'hatching_chick':'\ud83d\udc23',
      'headphones':'\ud83c\udfa7',
      'hear_no_evil':'\ud83d\ude49',
      'heart':'\u2764\ufe0f',
      'heart_decoration':'\ud83d\udc9f',
      'heart_eyes':'\ud83d\ude0d',
      'heart_eyes_cat':'\ud83d\ude3b',
      'heartbeat':'\ud83d\udc93',
      'heartpulse':'\ud83d\udc97',
      'hearts':'\u2665\ufe0f',
      'heavy_check_mark':'\u2714\ufe0f',
      'heavy_division_sign':'\u2797',
      'heavy_dollar_sign':'\ud83d\udcb2',
      'heavy_heart_exclamation':'\u2763\ufe0f',
      'heavy_minus_sign':'\u2796',
      'heavy_multiplication_x':'\u2716\ufe0f',
      'heavy_plus_sign':'\u2795',
      'helicopter':'\ud83d\ude81',
      'herb':'\ud83c\udf3f',
      'hibiscus':'\ud83c\udf3a',
      'high_brightness':'\ud83d\udd06',
      'high_heel':'\ud83d\udc60',
      'hocho':'\ud83d\udd2a',
      'hole':'\ud83d\udd73',
      'honey_pot':'\ud83c\udf6f',
      'horse':'\ud83d\udc34',
      'horse_racing':'\ud83c\udfc7',
      'hospital':'\ud83c\udfe5',
      'hot_pepper':'\ud83c\udf36',
      'hotdog':'\ud83c\udf2d',
      'hotel':'\ud83c\udfe8',
      'hotsprings':'\u2668\ufe0f',
      'hourglass':'\u231b\ufe0f',
      'hourglass_flowing_sand':'\u23f3',
      'house':'\ud83c\udfe0',
      'house_with_garden':'\ud83c\udfe1',
      'houses':'\ud83c\udfd8',
      'hugs':'\ud83e\udd17',
      'hushed':'\ud83d\ude2f',
      'ice_cream':'\ud83c\udf68',
      'ice_hockey':'\ud83c\udfd2',
      'ice_skate':'\u26f8',
      'icecream':'\ud83c\udf66',
      'id':'\ud83c\udd94',
      'ideograph_advantage':'\ud83c\ude50',
      'imp':'\ud83d\udc7f',
      'inbox_tray':'\ud83d\udce5',
      'incoming_envelope':'\ud83d\udce8',
      'tipping_hand_woman':'\ud83d\udc81',
      'information_source':'\u2139\ufe0f',
      'innocent':'\ud83d\ude07',
      'interrobang':'\u2049\ufe0f',
      'iphone':'\ud83d\udcf1',
      'izakaya_lantern':'\ud83c\udfee',
      'jack_o_lantern':'\ud83c\udf83',
      'japan':'\ud83d\uddfe',
      'japanese_castle':'\ud83c\udfef',
      'japanese_goblin':'\ud83d\udc7a',
      'japanese_ogre':'\ud83d\udc79',
      'jeans':'\ud83d\udc56',
      'joy':'\ud83d\ude02',
      'joy_cat':'\ud83d\ude39',
      'joystick':'\ud83d\udd79',
      'kaaba':'\ud83d\udd4b',
      'key':'\ud83d\udd11',
      'keyboard':'\u2328\ufe0f',
      'keycap_ten':'\ud83d\udd1f',
      'kick_scooter':'\ud83d\udef4',
      'kimono':'\ud83d\udc58',
      'kiss':'\ud83d\udc8b',
      'kissing':'\ud83d\ude17',
      'kissing_cat':'\ud83d\ude3d',
      'kissing_closed_eyes':'\ud83d\ude1a',
      'kissing_heart':'\ud83d\ude18',
      'kissing_smiling_eyes':'\ud83d\ude19',
      'kiwi_fruit':'\ud83e\udd5d',
      'koala':'\ud83d\udc28',
      'koko':'\ud83c\ude01',
      'label':'\ud83c\udff7',
      'large_blue_circle':'\ud83d\udd35',
      'large_blue_diamond':'\ud83d\udd37',
      'large_orange_diamond':'\ud83d\udd36',
      'last_quarter_moon':'\ud83c\udf17',
      'last_quarter_moon_with_face':'\ud83c\udf1c',
      'latin_cross':'\u271d\ufe0f',
      'laughing':'\ud83d\ude06',
      'leaves':'\ud83c\udf43',
      'ledger':'\ud83d\udcd2',
      'left_luggage':'\ud83d\udec5',
      'left_right_arrow':'\u2194\ufe0f',
      'leftwards_arrow_with_hook':'\u21a9\ufe0f',
      'lemon':'\ud83c\udf4b',
      'leo':'\u264c\ufe0f',
      'leopard':'\ud83d\udc06',
      'level_slider':'\ud83c\udf9a',
      'libra':'\u264e\ufe0f',
      'light_rail':'\ud83d\ude88',
      'link':'\ud83d\udd17',
      'lion':'\ud83e\udd81',
      'lips':'\ud83d\udc44',
      'lipstick':'\ud83d\udc84',
      'lizard':'\ud83e\udd8e',
      'lock':'\ud83d\udd12',
      'lock_with_ink_pen':'\ud83d\udd0f',
      'lollipop':'\ud83c\udf6d',
      'loop':'\u27bf',
      'loud_sound':'\ud83d\udd0a',
      'loudspeaker':'\ud83d\udce2',
      'love_hotel':'\ud83c\udfe9',
      'love_letter':'\ud83d\udc8c',
      'low_brightness':'\ud83d\udd05',
      'lying_face':'\ud83e\udd25',
      'm':'\u24c2\ufe0f',
      'mag':'\ud83d\udd0d',
      'mag_right':'\ud83d\udd0e',
      'mahjong':'\ud83c\udc04\ufe0f',
      'mailbox':'\ud83d\udceb',
      'mailbox_closed':'\ud83d\udcea',
      'mailbox_with_mail':'\ud83d\udcec',
      'mailbox_with_no_mail':'\ud83d\udced',
      'man':'\ud83d\udc68',
      'man_artist':'\ud83d\udc68&zwj;\ud83c\udfa8',
      'man_astronaut':'\ud83d\udc68&zwj;\ud83d\ude80',
      'man_cartwheeling':'\ud83e\udd38&zwj;\u2642\ufe0f',
      'man_cook':'\ud83d\udc68&zwj;\ud83c\udf73',
      'man_dancing':'\ud83d\udd7a',
      'man_facepalming':'\ud83e\udd26&zwj;\u2642\ufe0f',
      'man_factory_worker':'\ud83d\udc68&zwj;\ud83c\udfed',
      'man_farmer':'\ud83d\udc68&zwj;\ud83c\udf3e',
      'man_firefighter':'\ud83d\udc68&zwj;\ud83d\ude92',
      'man_health_worker':'\ud83d\udc68&zwj;\u2695\ufe0f',
      'man_in_tuxedo':'\ud83e\udd35',
      'man_judge':'\ud83d\udc68&zwj;\u2696\ufe0f',
      'man_juggling':'\ud83e\udd39&zwj;\u2642\ufe0f',
      'man_mechanic':'\ud83d\udc68&zwj;\ud83d\udd27',
      'man_office_worker':'\ud83d\udc68&zwj;\ud83d\udcbc',
      'man_pilot':'\ud83d\udc68&zwj;\u2708\ufe0f',
      'man_playing_handball':'\ud83e\udd3e&zwj;\u2642\ufe0f',
      'man_playing_water_polo':'\ud83e\udd3d&zwj;\u2642\ufe0f',
      'man_scientist':'\ud83d\udc68&zwj;\ud83d\udd2c',
      'man_shrugging':'\ud83e\udd37&zwj;\u2642\ufe0f',
      'man_singer':'\ud83d\udc68&zwj;\ud83c\udfa4',
      'man_student':'\ud83d\udc68&zwj;\ud83c\udf93',
      'man_teacher':'\ud83d\udc68&zwj;\ud83c\udfeb',
      'man_technologist':'\ud83d\udc68&zwj;\ud83d\udcbb',
      'man_with_gua_pi_mao':'\ud83d\udc72',
      'man_with_turban':'\ud83d\udc73',
      'tangerine':'\ud83c\udf4a',
      'mans_shoe':'\ud83d\udc5e',
      'mantelpiece_clock':'\ud83d\udd70',
      'maple_leaf':'\ud83c\udf41',
      'martial_arts_uniform':'\ud83e\udd4b',
      'mask':'\ud83d\ude37',
      'massage_woman':'\ud83d\udc86',
      'massage_man':'\ud83d\udc86&zwj;\u2642\ufe0f',
      'meat_on_bone':'\ud83c\udf56',
      'medal_military':'\ud83c\udf96',
      'medal_sports':'\ud83c\udfc5',
      'mega':'\ud83d\udce3',
      'melon':'\ud83c\udf48',
      'memo':'\ud83d\udcdd',
      'men_wrestling':'\ud83e\udd3c&zwj;\u2642\ufe0f',
      'menorah':'\ud83d\udd4e',
      'mens':'\ud83d\udeb9',
      'metal':'\ud83e\udd18',
      'metro':'\ud83d\ude87',
      'microphone':'\ud83c\udfa4',
      'microscope':'\ud83d\udd2c',
      'milk_glass':'\ud83e\udd5b',
      'milky_way':'\ud83c\udf0c',
      'minibus':'\ud83d\ude90',
      'minidisc':'\ud83d\udcbd',
      'mobile_phone_off':'\ud83d\udcf4',
      'money_mouth_face':'\ud83e\udd11',
      'money_with_wings':'\ud83d\udcb8',
      'moneybag':'\ud83d\udcb0',
      'monkey':'\ud83d\udc12',
      'monkey_face':'\ud83d\udc35',
      'monorail':'\ud83d\ude9d',
      'moon':'\ud83c\udf14',
      'mortar_board':'\ud83c\udf93',
      'mosque':'\ud83d\udd4c',
      'motor_boat':'\ud83d\udee5',
      'motor_scooter':'\ud83d\udef5',
      'motorcycle':'\ud83c\udfcd',
      'motorway':'\ud83d\udee3',
      'mount_fuji':'\ud83d\uddfb',
      'mountain':'\u26f0',
      'mountain_biking_man':'\ud83d\udeb5',
      'mountain_biking_woman':'\ud83d\udeb5&zwj;\u2640\ufe0f',
      'mountain_cableway':'\ud83d\udea0',
      'mountain_railway':'\ud83d\ude9e',
      'mountain_snow':'\ud83c\udfd4',
      'mouse':'\ud83d\udc2d',
      'mouse2':'\ud83d\udc01',
      'movie_camera':'\ud83c\udfa5',
      'moyai':'\ud83d\uddff',
      'mrs_claus':'\ud83e\udd36',
      'muscle':'\ud83d\udcaa',
      'mushroom':'\ud83c\udf44',
      'musical_keyboard':'\ud83c\udfb9',
      'musical_note':'\ud83c\udfb5',
      'musical_score':'\ud83c\udfbc',
      'mute':'\ud83d\udd07',
      'nail_care':'\ud83d\udc85',
      'name_badge':'\ud83d\udcdb',
      'national_park':'\ud83c\udfde',
      'nauseated_face':'\ud83e\udd22',
      'necktie':'\ud83d\udc54',
      'negative_squared_cross_mark':'\u274e',
      'nerd_face':'\ud83e\udd13',
      'neutral_face':'\ud83d\ude10',
      'new':'\ud83c\udd95',
      'new_moon':'\ud83c\udf11',
      'new_moon_with_face':'\ud83c\udf1a',
      'newspaper':'\ud83d\udcf0',
      'newspaper_roll':'\ud83d\uddde',
      'next_track_button':'\u23ed',
      'ng':'\ud83c\udd96',
      'no_good_man':'\ud83d\ude45&zwj;\u2642\ufe0f',
      'no_good_woman':'\ud83d\ude45',
      'night_with_stars':'\ud83c\udf03',
      'no_bell':'\ud83d\udd15',
      'no_bicycles':'\ud83d\udeb3',
      'no_entry':'\u26d4\ufe0f',
      'no_entry_sign':'\ud83d\udeab',
      'no_mobile_phones':'\ud83d\udcf5',
      'no_mouth':'\ud83d\ude36',
      'no_pedestrians':'\ud83d\udeb7',
      'no_smoking':'\ud83d\udead',
      'non-potable_water':'\ud83d\udeb1',
      'nose':'\ud83d\udc43',
      'notebook':'\ud83d\udcd3',
      'notebook_with_decorative_cover':'\ud83d\udcd4',
      'notes':'\ud83c\udfb6',
      'nut_and_bolt':'\ud83d\udd29',
      'o':'\u2b55\ufe0f',
      'o2':'\ud83c\udd7e\ufe0f',
      'ocean':'\ud83c\udf0a',
      'octopus':'\ud83d\udc19',
      'oden':'\ud83c\udf62',
      'office':'\ud83c\udfe2',
      'oil_drum':'\ud83d\udee2',
      'ok':'\ud83c\udd97',
      'ok_hand':'\ud83d\udc4c',
      'ok_man':'\ud83d\ude46&zwj;\u2642\ufe0f',
      'ok_woman':'\ud83d\ude46',
      'old_key':'\ud83d\udddd',
      'older_man':'\ud83d\udc74',
      'older_woman':'\ud83d\udc75',
      'om':'\ud83d\udd49',
      'on':'\ud83d\udd1b',
      'oncoming_automobile':'\ud83d\ude98',
      'oncoming_bus':'\ud83d\ude8d',
      'oncoming_police_car':'\ud83d\ude94',
      'oncoming_taxi':'\ud83d\ude96',
      'open_file_folder':'\ud83d\udcc2',
      'open_hands':'\ud83d\udc50',
      'open_mouth':'\ud83d\ude2e',
      'open_umbrella':'\u2602\ufe0f',
      'ophiuchus':'\u26ce',
      'orange_book':'\ud83d\udcd9',
      'orthodox_cross':'\u2626\ufe0f',
      'outbox_tray':'\ud83d\udce4',
      'owl':'\ud83e\udd89',
      'ox':'\ud83d\udc02',
      'package':'\ud83d\udce6',
      'page_facing_up':'\ud83d\udcc4',
      'page_with_curl':'\ud83d\udcc3',
      'pager':'\ud83d\udcdf',
      'paintbrush':'\ud83d\udd8c',
      'palm_tree':'\ud83c\udf34',
      'pancakes':'\ud83e\udd5e',
      'panda_face':'\ud83d\udc3c',
      'paperclip':'\ud83d\udcce',
      'paperclips':'\ud83d\udd87',
      'parasol_on_ground':'\u26f1',
      'parking':'\ud83c\udd7f\ufe0f',
      'part_alternation_mark':'\u303d\ufe0f',
      'partly_sunny':'\u26c5\ufe0f',
      'passenger_ship':'\ud83d\udef3',
      'passport_control':'\ud83d\udec2',
      'pause_button':'\u23f8',
      'peace_symbol':'\u262e\ufe0f',
      'peach':'\ud83c\udf51',
      'peanuts':'\ud83e\udd5c',
      'pear':'\ud83c\udf50',
      'pen':'\ud83d\udd8a',
      'pencil2':'\u270f\ufe0f',
      'penguin':'\ud83d\udc27',
      'pensive':'\ud83d\ude14',
      'performing_arts':'\ud83c\udfad',
      'persevere':'\ud83d\ude23',
      'person_fencing':'\ud83e\udd3a',
      'pouting_woman':'\ud83d\ude4e',
      'phone':'\u260e\ufe0f',
      'pick':'\u26cf',
      'pig':'\ud83d\udc37',
      'pig2':'\ud83d\udc16',
      'pig_nose':'\ud83d\udc3d',
      'pill':'\ud83d\udc8a',
      'pineapple':'\ud83c\udf4d',
      'ping_pong':'\ud83c\udfd3',
      'pisces':'\u2653\ufe0f',
      'pizza':'\ud83c\udf55',
      'place_of_worship':'\ud83d\uded0',
      'plate_with_cutlery':'\ud83c\udf7d',
      'play_or_pause_button':'\u23ef',
      'point_down':'\ud83d\udc47',
      'point_left':'\ud83d\udc48',
      'point_right':'\ud83d\udc49',
      'point_up':'\u261d\ufe0f',
      'point_up_2':'\ud83d\udc46',
      'police_car':'\ud83d\ude93',
      'policewoman':'\ud83d\udc6e&zwj;\u2640\ufe0f',
      'poodle':'\ud83d\udc29',
      'popcorn':'\ud83c\udf7f',
      'post_office':'\ud83c\udfe3',
      'postal_horn':'\ud83d\udcef',
      'postbox':'\ud83d\udcee',
      'potable_water':'\ud83d\udeb0',
      'potato':'\ud83e\udd54',
      'pouch':'\ud83d\udc5d',
      'poultry_leg':'\ud83c\udf57',
      'pound':'\ud83d\udcb7',
      'rage':'\ud83d\ude21',
      'pouting_cat':'\ud83d\ude3e',
      'pouting_man':'\ud83d\ude4e&zwj;\u2642\ufe0f',
      'pray':'\ud83d\ude4f',
      'prayer_beads':'\ud83d\udcff',
      'pregnant_woman':'\ud83e\udd30',
      'previous_track_button':'\u23ee',
      'prince':'\ud83e\udd34',
      'princess':'\ud83d\udc78',
      'printer':'\ud83d\udda8',
      'purple_heart':'\ud83d\udc9c',
      'purse':'\ud83d\udc5b',
      'pushpin':'\ud83d\udccc',
      'put_litter_in_its_place':'\ud83d\udeae',
      'question':'\u2753',
      'rabbit':'\ud83d\udc30',
      'rabbit2':'\ud83d\udc07',
      'racehorse':'\ud83d\udc0e',
      'racing_car':'\ud83c\udfce',
      'radio':'\ud83d\udcfb',
      'radio_button':'\ud83d\udd18',
      'radioactive':'\u2622\ufe0f',
      'railway_car':'\ud83d\ude83',
      'railway_track':'\ud83d\udee4',
      'rainbow':'\ud83c\udf08',
      'rainbow_flag':'\ud83c\udff3\ufe0f&zwj;\ud83c\udf08',
      'raised_back_of_hand':'\ud83e\udd1a',
      'raised_hand_with_fingers_splayed':'\ud83d\udd90',
      'raised_hands':'\ud83d\ude4c',
      'raising_hand_woman':'\ud83d\ude4b',
      'raising_hand_man':'\ud83d\ude4b&zwj;\u2642\ufe0f',
      'ram':'\ud83d\udc0f',
      'ramen':'\ud83c\udf5c',
      'rat':'\ud83d\udc00',
      'record_button':'\u23fa',
      'recycle':'\u267b\ufe0f',
      'red_circle':'\ud83d\udd34',
      'registered':'\u00ae\ufe0f',
      'relaxed':'\u263a\ufe0f',
      'relieved':'\ud83d\ude0c',
      'reminder_ribbon':'\ud83c\udf97',
      'repeat':'\ud83d\udd01',
      'repeat_one':'\ud83d\udd02',
      'rescue_worker_helmet':'\u26d1',
      'restroom':'\ud83d\udebb',
      'revolving_hearts':'\ud83d\udc9e',
      'rewind':'\u23ea',
      'rhinoceros':'\ud83e\udd8f',
      'ribbon':'\ud83c\udf80',
      'rice':'\ud83c\udf5a',
      'rice_ball':'\ud83c\udf59',
      'rice_cracker':'\ud83c\udf58',
      'rice_scene':'\ud83c\udf91',
      'right_anger_bubble':'\ud83d\uddef',
      'ring':'\ud83d\udc8d',
      'robot':'\ud83e\udd16',
      'rocket':'\ud83d\ude80',
      'rofl':'\ud83e\udd23',
      'roll_eyes':'\ud83d\ude44',
      'roller_coaster':'\ud83c\udfa2',
      'rooster':'\ud83d\udc13',
      'rose':'\ud83c\udf39',
      'rosette':'\ud83c\udff5',
      'rotating_light':'\ud83d\udea8',
      'round_pushpin':'\ud83d\udccd',
      'rowing_man':'\ud83d\udea3',
      'rowing_woman':'\ud83d\udea3&zwj;\u2640\ufe0f',
      'rugby_football':'\ud83c\udfc9',
      'running_man':'\ud83c\udfc3',
      'running_shirt_with_sash':'\ud83c\udfbd',
      'running_woman':'\ud83c\udfc3&zwj;\u2640\ufe0f',
      'sa':'\ud83c\ude02\ufe0f',
      'sagittarius':'\u2650\ufe0f',
      'sake':'\ud83c\udf76',
      'sandal':'\ud83d\udc61',
      'santa':'\ud83c\udf85',
      'satellite':'\ud83d\udce1',
      'saxophone':'\ud83c\udfb7',
      'school':'\ud83c\udfeb',
      'school_satchel':'\ud83c\udf92',
      'scissors':'\u2702\ufe0f',
      'scorpion':'\ud83e\udd82',
      'scorpius':'\u264f\ufe0f',
      'scream':'\ud83d\ude31',
      'scream_cat':'\ud83d\ude40',
      'scroll':'\ud83d\udcdc',
      'seat':'\ud83d\udcba',
      'secret':'\u3299\ufe0f',
      'see_no_evil':'\ud83d\ude48',
      'seedling':'\ud83c\udf31',
      'selfie':'\ud83e\udd33',
      'shallow_pan_of_food':'\ud83e\udd58',
      'shamrock':'\u2618\ufe0f',
      'shark':'\ud83e\udd88',
      'shaved_ice':'\ud83c\udf67',
      'sheep':'\ud83d\udc11',
      'shell':'\ud83d\udc1a',
      'shield':'\ud83d\udee1',
      'shinto_shrine':'\u26e9',
      'ship':'\ud83d\udea2',
      'shirt':'\ud83d\udc55',
      'shopping':'\ud83d\udecd',
      'shopping_cart':'\ud83d\uded2',
      'shower':'\ud83d\udebf',
      'shrimp':'\ud83e\udd90',
      'signal_strength':'\ud83d\udcf6',
      'six_pointed_star':'\ud83d\udd2f',
      'ski':'\ud83c\udfbf',
      'skier':'\u26f7',
      'skull':'\ud83d\udc80',
      'skull_and_crossbones':'\u2620\ufe0f',
      'sleeping':'\ud83d\ude34',
      'sleeping_bed':'\ud83d\udecc',
      'sleepy':'\ud83d\ude2a',
      'slightly_frowning_face':'\ud83d\ude41',
      'slightly_smiling_face':'\ud83d\ude42',
      'slot_machine':'\ud83c\udfb0',
      'small_airplane':'\ud83d\udee9',
      'small_blue_diamond':'\ud83d\udd39',
      'small_orange_diamond':'\ud83d\udd38',
      'small_red_triangle':'\ud83d\udd3a',
      'small_red_triangle_down':'\ud83d\udd3b',
      'smile':'\ud83d\ude04',
      'smile_cat':'\ud83d\ude38',
      'smiley':'\ud83d\ude03',
      'smiley_cat':'\ud83d\ude3a',
      'smiling_imp':'\ud83d\ude08',
      'smirk':'\ud83d\ude0f',
      'smirk_cat':'\ud83d\ude3c',
      'smoking':'\ud83d\udeac',
      'snail':'\ud83d\udc0c',
      'snake':'\ud83d\udc0d',
      'sneezing_face':'\ud83e\udd27',
      'snowboarder':'\ud83c\udfc2',
      'snowflake':'\u2744\ufe0f',
      'snowman':'\u26c4\ufe0f',
      'snowman_with_snow':'\u2603\ufe0f',
      'sob':'\ud83d\ude2d',
      'soccer':'\u26bd\ufe0f',
      'soon':'\ud83d\udd1c',
      'sos':'\ud83c\udd98',
      'sound':'\ud83d\udd09',
      'space_invader':'\ud83d\udc7e',
      'spades':'\u2660\ufe0f',
      'spaghetti':'\ud83c\udf5d',
      'sparkle':'\u2747\ufe0f',
      'sparkler':'\ud83c\udf87',
      'sparkles':'\u2728',
      'sparkling_heart':'\ud83d\udc96',
      'speak_no_evil':'\ud83d\ude4a',
      'speaker':'\ud83d\udd08',
      'speaking_head':'\ud83d\udde3',
      'speech_balloon':'\ud83d\udcac',
      'speedboat':'\ud83d\udea4',
      'spider':'\ud83d\udd77',
      'spider_web':'\ud83d\udd78',
      'spiral_calendar':'\ud83d\uddd3',
      'spiral_notepad':'\ud83d\uddd2',
      'spoon':'\ud83e\udd44',
      'squid':'\ud83e\udd91',
      'stadium':'\ud83c\udfdf',
      'star':'\u2b50\ufe0f',
      'star2':'\ud83c\udf1f',
      'star_and_crescent':'\u262a\ufe0f',
      'star_of_david':'\u2721\ufe0f',
      'stars':'\ud83c\udf20',
      'station':'\ud83d\ude89',
      'statue_of_liberty':'\ud83d\uddfd',
      'steam_locomotive':'\ud83d\ude82',
      'stew':'\ud83c\udf72',
      'stop_button':'\u23f9',
      'stop_sign':'\ud83d\uded1',
      'stopwatch':'\u23f1',
      'straight_ruler':'\ud83d\udccf',
      'strawberry':'\ud83c\udf53',
      'stuck_out_tongue':'\ud83d\ude1b',
      'stuck_out_tongue_closed_eyes':'\ud83d\ude1d',
      'stuck_out_tongue_winking_eye':'\ud83d\ude1c',
      'studio_microphone':'\ud83c\udf99',
      'stuffed_flatbread':'\ud83e\udd59',
      'sun_behind_large_cloud':'\ud83c\udf25',
      'sun_behind_rain_cloud':'\ud83c\udf26',
      'sun_behind_small_cloud':'\ud83c\udf24',
      'sun_with_face':'\ud83c\udf1e',
      'sunflower':'\ud83c\udf3b',
      'sunglasses':'\ud83d\ude0e',
      'sunny':'\u2600\ufe0f',
      'sunrise':'\ud83c\udf05',
      'sunrise_over_mountains':'\ud83c\udf04',
      'surfing_man':'\ud83c\udfc4',
      'surfing_woman':'\ud83c\udfc4&zwj;\u2640\ufe0f',
      'sushi':'\ud83c\udf63',
      'suspension_railway':'\ud83d\ude9f',
      'sweat':'\ud83d\ude13',
      'sweat_drops':'\ud83d\udca6',
      'sweat_smile':'\ud83d\ude05',
      'sweet_potato':'\ud83c\udf60',
      'swimming_man':'\ud83c\udfca',
      'swimming_woman':'\ud83c\udfca&zwj;\u2640\ufe0f',
      'symbols':'\ud83d\udd23',
      'synagogue':'\ud83d\udd4d',
      'syringe':'\ud83d\udc89',
      'taco':'\ud83c\udf2e',
      'tada':'\ud83c\udf89',
      'tanabata_tree':'\ud83c\udf8b',
      'taurus':'\u2649\ufe0f',
      'taxi':'\ud83d\ude95',
      'tea':'\ud83c\udf75',
      'telephone_receiver':'\ud83d\udcde',
      'telescope':'\ud83d\udd2d',
      'tennis':'\ud83c\udfbe',
      'tent':'\u26fa\ufe0f',
      'thermometer':'\ud83c\udf21',
      'thinking':'\ud83e\udd14',
      'thought_balloon':'\ud83d\udcad',
      'ticket':'\ud83c\udfab',
      'tickets':'\ud83c\udf9f',
      'tiger':'\ud83d\udc2f',
      'tiger2':'\ud83d\udc05',
      'timer_clock':'\u23f2',
      'tipping_hand_man':'\ud83d\udc81&zwj;\u2642\ufe0f',
      'tired_face':'\ud83d\ude2b',
      'tm':'\u2122\ufe0f',
      'toilet':'\ud83d\udebd',
      'tokyo_tower':'\ud83d\uddfc',
      'tomato':'\ud83c\udf45',
      'tongue':'\ud83d\udc45',
      'top':'\ud83d\udd1d',
      'tophat':'\ud83c\udfa9',
      'tornado':'\ud83c\udf2a',
      'trackball':'\ud83d\uddb2',
      'tractor':'\ud83d\ude9c',
      'traffic_light':'\ud83d\udea5',
      'train':'\ud83d\ude8b',
      'train2':'\ud83d\ude86',
      'tram':'\ud83d\ude8a',
      'triangular_flag_on_post':'\ud83d\udea9',
      'triangular_ruler':'\ud83d\udcd0',
      'trident':'\ud83d\udd31',
      'triumph':'\ud83d\ude24',
      'trolleybus':'\ud83d\ude8e',
      'trophy':'\ud83c\udfc6',
      'tropical_drink':'\ud83c\udf79',
      'tropical_fish':'\ud83d\udc20',
      'truck':'\ud83d\ude9a',
      'trumpet':'\ud83c\udfba',
      'tulip':'\ud83c\udf37',
      'tumbler_glass':'\ud83e\udd43',
      'turkey':'\ud83e\udd83',
      'turtle':'\ud83d\udc22',
      'tv':'\ud83d\udcfa',
      'twisted_rightwards_arrows':'\ud83d\udd00',
      'two_hearts':'\ud83d\udc95',
      'two_men_holding_hands':'\ud83d\udc6c',
      'two_women_holding_hands':'\ud83d\udc6d',
      'u5272':'\ud83c\ude39',
      'u5408':'\ud83c\ude34',
      'u55b6':'\ud83c\ude3a',
      'u6307':'\ud83c\ude2f\ufe0f',
      'u6708':'\ud83c\ude37\ufe0f',
      'u6709':'\ud83c\ude36',
      'u6e80':'\ud83c\ude35',
      'u7121':'\ud83c\ude1a\ufe0f',
      'u7533':'\ud83c\ude38',
      'u7981':'\ud83c\ude32',
      'u7a7a':'\ud83c\ude33',
      'umbrella':'\u2614\ufe0f',
      'unamused':'\ud83d\ude12',
      'underage':'\ud83d\udd1e',
      'unicorn':'\ud83e\udd84',
      'unlock':'\ud83d\udd13',
      'up':'\ud83c\udd99',
      'upside_down_face':'\ud83d\ude43',
      'v':'\u270c\ufe0f',
      'vertical_traffic_light':'\ud83d\udea6',
      'vhs':'\ud83d\udcfc',
      'vibration_mode':'\ud83d\udcf3',
      'video_camera':'\ud83d\udcf9',
      'video_game':'\ud83c\udfae',
      'violin':'\ud83c\udfbb',
      'virgo':'\u264d\ufe0f',
      'volcano':'\ud83c\udf0b',
      'volleyball':'\ud83c\udfd0',
      'vs':'\ud83c\udd9a',
      'vulcan_salute':'\ud83d\udd96',
      'walking_man':'\ud83d\udeb6',
      'walking_woman':'\ud83d\udeb6&zwj;\u2640\ufe0f',
      'waning_crescent_moon':'\ud83c\udf18',
      'waning_gibbous_moon':'\ud83c\udf16',
      'warning':'\u26a0\ufe0f',
      'wastebasket':'\ud83d\uddd1',
      'watch':'\u231a\ufe0f',
      'water_buffalo':'\ud83d\udc03',
      'watermelon':'\ud83c\udf49',
      'wave':'\ud83d\udc4b',
      'wavy_dash':'\u3030\ufe0f',
      'waxing_crescent_moon':'\ud83c\udf12',
      'wc':'\ud83d\udebe',
      'weary':'\ud83d\ude29',
      'wedding':'\ud83d\udc92',
      'weight_lifting_man':'\ud83c\udfcb\ufe0f',
      'weight_lifting_woman':'\ud83c\udfcb\ufe0f&zwj;\u2640\ufe0f',
      'whale':'\ud83d\udc33',
      'whale2':'\ud83d\udc0b',
      'wheel_of_dharma':'\u2638\ufe0f',
      'wheelchair':'\u267f\ufe0f',
      'white_check_mark':'\u2705',
      'white_circle':'\u26aa\ufe0f',
      'white_flag':'\ud83c\udff3\ufe0f',
      'white_flower':'\ud83d\udcae',
      'white_large_square':'\u2b1c\ufe0f',
      'white_medium_small_square':'\u25fd\ufe0f',
      'white_medium_square':'\u25fb\ufe0f',
      'white_small_square':'\u25ab\ufe0f',
      'white_square_button':'\ud83d\udd33',
      'wilted_flower':'\ud83e\udd40',
      'wind_chime':'\ud83c\udf90',
      'wind_face':'\ud83c\udf2c',
      'wine_glass':'\ud83c\udf77',
      'wink':'\ud83d\ude09',
      'wolf':'\ud83d\udc3a',
      'woman':'\ud83d\udc69',
      'woman_artist':'\ud83d\udc69&zwj;\ud83c\udfa8',
      'woman_astronaut':'\ud83d\udc69&zwj;\ud83d\ude80',
      'woman_cartwheeling':'\ud83e\udd38&zwj;\u2640\ufe0f',
      'woman_cook':'\ud83d\udc69&zwj;\ud83c\udf73',
      'woman_facepalming':'\ud83e\udd26&zwj;\u2640\ufe0f',
      'woman_factory_worker':'\ud83d\udc69&zwj;\ud83c\udfed',
      'woman_farmer':'\ud83d\udc69&zwj;\ud83c\udf3e',
      'woman_firefighter':'\ud83d\udc69&zwj;\ud83d\ude92',
      'woman_health_worker':'\ud83d\udc69&zwj;\u2695\ufe0f',
      'woman_judge':'\ud83d\udc69&zwj;\u2696\ufe0f',
      'woman_juggling':'\ud83e\udd39&zwj;\u2640\ufe0f',
      'woman_mechanic':'\ud83d\udc69&zwj;\ud83d\udd27',
      'woman_office_worker':'\ud83d\udc69&zwj;\ud83d\udcbc',
      'woman_pilot':'\ud83d\udc69&zwj;\u2708\ufe0f',
      'woman_playing_handball':'\ud83e\udd3e&zwj;\u2640\ufe0f',
      'woman_playing_water_polo':'\ud83e\udd3d&zwj;\u2640\ufe0f',
      'woman_scientist':'\ud83d\udc69&zwj;\ud83d\udd2c',
      'woman_shrugging':'\ud83e\udd37&zwj;\u2640\ufe0f',
      'woman_singer':'\ud83d\udc69&zwj;\ud83c\udfa4',
      'woman_student':'\ud83d\udc69&zwj;\ud83c\udf93',
      'woman_teacher':'\ud83d\udc69&zwj;\ud83c\udfeb',
      'woman_technologist':'\ud83d\udc69&zwj;\ud83d\udcbb',
      'woman_with_turban':'\ud83d\udc73&zwj;\u2640\ufe0f',
      'womans_clothes':'\ud83d\udc5a',
      'womans_hat':'\ud83d\udc52',
      'women_wrestling':'\ud83e\udd3c&zwj;\u2640\ufe0f',
      'womens':'\ud83d\udeba',
      'world_map':'\ud83d\uddfa',
      'worried':'\ud83d\ude1f',
      'wrench':'\ud83d\udd27',
      'writing_hand':'\u270d\ufe0f',
      'x':'\u274c',
      'yellow_heart':'\ud83d\udc9b',
      'yen':'\ud83d\udcb4',
      'yin_yang':'\u262f\ufe0f',
      'yum':'\ud83d\ude0b',
      'zap':'\u26a1\ufe0f',
      'zipper_mouth_face':'\ud83e\udd10',
      'zzz':'\ud83d\udca4',

      /* special emojis :P */
      'octocat':  '<img width="20" height="20" align="absmiddle" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAOwUlEQVR42uVbCVyO6RbPmn0sw9gZS0aZO4y5GTEUE2ObxjZjrbHEJVy3sWS5pkaWxjLEkCVDSbSgFLdESaWSLIVUSIi4kvb9f895vi/zbbR+yZ339/tbnu99n/ec/3Oe85xznufV0CjDBaAdwZqwnzCJ0FXjHV70/i8J5oQDhCFV8cJdq1atwqxZs+Ds7Iz4+HhqwgXCLELNKlK6G2Ej4e6lS5ewZcsWzJgxA+fOnWNZFqvzxT1v3boF/qcsBg0ahP3796OwsJAFWKYuIqjfPoS9cXFxWL58Obp06SInh5aWFr//jjoJWLlu3TolAorRuXNn7Ny5k4W4Spgj81xrgj5hLmED4RDhlNRygglBhADCSakpWxFMCHoETUJTwrYHDx7A1NT0je9nPHz4kN/fXl0EeI0aNeqtAjB69+4NPz8/FsSdlXvy5An8/f1hZ2cHCwsLGBsbY/To0cJy9PT0MGDAAAwePBhGRkbClNesWYODBw8iODgYOTk53M/d9evXo27duiW++8iRI3z/ZHURENOjR48ShSjGuHHjhHJ16tQp9TOKaNWqlZKpvw1MHluQOpSvk5eXh5YtW5ZbmarAvHnzmIBd6iCgXnZ2Npo1a1atCWAfwY5SHQTUKCoqQocOHao1AebmHBJgi7p8QBDP6epMwKFDvMDAWF0ELLS1ta3WBNy9e5cJMFIXAdvt7e2rNQHDhw9nAv5D+KKylV9y8+bNCi1pVYWZM2cyCfaVTcDdsqzH7xpBQRxcwqyylLdi5/K+KM/Q0dFhAqIri4Bn1T0AUgVpdmhYUeVHnD59+r1TnjF27Fgm4HhFCThoYmLyXhLQoEGD4mRKsyIE3OrZs+d7SQCDCyZcNSqv8k1evXoFTU3NUr+wzUcfYqRBf8yb/C2WzfoBFoTF08fBdMIITDD8CsP1+kL30x7Q6dYZH7drjfZ0f4fWLdG1Q1t81qMLBvTRwejB/TBl1BDMnzQGS2dMxKo5k7Fs9iSY/jAaBvR8Pc26pZaH02quLZSXgO6xsbGlelGnli1wZKcVMqN8gKcRwItrf+K/VB95doXaLwOJIVSzOU/+2Re5kV7IuuyJrIhTyLt6mmztLBBPNZLHoUAy9fE8UvJ8ikxfj8PwJPQErJeYlkquTZs2MQFLykuANgc/Jb2kn3Z3ZMaQUrmxwO1zyAo7gfRAJ6RfOIyMEFdkXj5F8BTK5lzxQv610yi8QcFatI8gQoCIK7x+hojwRnaE5H4JTiEj9Pjr/rJDqcZyn9b4ovu45LYbdWvXeqtsXMHiSlZ5CegRExPz1hd83PYj5POo0QinXyLFg48hnZTOiQ1Dzr1IZEaeQRoJn0HKZIR7lA2kfHrQUerXHTlx4ZL+rnjjFRGRGeYB5MUj2GnbW+XbuJFrp1heXgI6JCYmvvUFN1x3Aek3SWkapRAXMeJFGS8ge2Xfuog0toaykED3Mpk8+shOk+sv68Y50V9WuKewBKt5094o39atW/mRf5WXgIYZGRlo3Lixys4nj6A6Z1YMcqRCpwU4ouDlUyHk/QA/hNttR25Wlvh/ZthJUsil9ATQ/axkYbqEzDgfL0Ts/x35+aLyTES7IY36Q6w/+Q4/tP6wuUoZ9+7dy7ebVmQZjO/atavKzn32rAdeXkd6KCkXdAxZ13yFcLFnvPD73zrDVrsdTs6eggKSuSjjORHkUGoC0i86Iyc6QPQX7eqMnTodYNuzHU4vnosiaitMSUSavwMy6d3IvEUrzViVMrq5uXEX4ytCgL++vr5Sx7Vr1cIDX0dKkQJfj37Rs3jw1sBxkwlwGD4Ax3+ciN1faCHW76xQRFgAOcjSEMBkIe0x8nLzcez7kTg8Rh/uxuOxR/cTJISFSfq7eATpZCk8CAfXLVFJwIULXHnHoIoQYLtw4UKljps2aogXQcQuef/XAiMDKY+S4DhyEFwpDnCj9f+Afl8EbbWRTANaAdihlYoAMn8aZzyNuYODX/eD29TvRH/7v+qN8H27JdOAyWQfQQ74xPafVRLAPox9WUlK6hIGEgx4f00Kg2JcvHhRqeP6FIwknXemyen/2gLIIeC/CYk49M0AuE4xgtu0sThg8AUCN62TEuBdRgJo2Y+Kxh9D/k59SQiwH9QHobt3SAk4KSGA4oWjm1YqyVi8U6Soj4yOrHM/jTAyKVby/PnzIoNi8L+L4eXlpXoFcLcTgc1rAlISkJeXDxeK2A6P1hdTwI6mQPTJE+WbAlnJyE7PhNO3Q3BkrKGYWtxfHMkkmQLO0ilwA7+vXqAkn66urtBLUZ9iHfm30NBQaPAf165dA0d9vP2UlJSEp0+f4vHjx3j06JH4e+rUqUovcNmyGkiNEkLwklXsBG+ecMUOnfbYod1emG5uboFKJ8jPFVD0l0dBUHqoPDHpQeQEb0qc4FUHe3KAbYUT9JgzDbwOFL5MfN0fXkXhJ5PxSvLt2LFD1Ah5u4z1YJ14l4qnBe8v3rhxAzz4PAVG8nLHivIP0dHRiIiIQGRkpEgmrl69ClW1QBMjQ7LDW8hmU+RRI69ckJIkhL7jfRJBm62R+TJVYq6h0jhBRslsivqenT2MF/7OyI70VmkFhWnPJaS6OyPkt43IycqR9EfWlH7JDQUUTuNhCHR7Ke9YcRp/5coVoQPrcvnyZURFRYmBZlLS0kR8MVLD29sbnp6e8PHxQUBAgCgn8YO8E3z79m3BGKeVc+bMkXuBZt06SA12F/F5Go0gR4C8HBalPZMPXKL8lQKhPAqF+f97KXFyNx6HQsoPsshJ/kmAp2TKkJLISpXvjyxNhMYcDVLOEO+lPDi8B5mamipkZx1YF9YpJCRErAy+vr5CZ9ZdWABhDGEYYTBhAOFz3g4nfMJelNCbkNCpUye5F034mvxIPi1/FM+zQCw0k5B9O0iEr5kRXkqhMJOVf9NXIHjtT7hmaymSoBzKETimkAuFpaF1dkwI9RcmIYaXv3BJXoGCuyIgk5WpefPmKCgoYK46SmX/RKoL69Sfl0WuFEl1HlmWJXE5z6WmTZvKJxxmxkIQ3AuU5APk6NICj4hRT6eITTEEzqWk55HHPjz3cxJhNF5cxeNT9kj2cRDTQjEkzpDtjyyCic5l5fEA7uSHFEefR5pPsahrb2B9QkICFHeJ51HunkdLIg0VLY0BFKdLwllVHp4dHyvst3QuEiiju21vA/+VZkiluIKt4I3RIfWXQ4QgKUxkni47LJWUP3PmjHo2RxVI+CebmKJP6EiFDVurxUgmExe5PHlnPAkn8w4QqW62NCVmYopozid5H0CI9RKE21ggJeAYEeMnfitOnRn5XCfgeJ+VTosWQU8MOc6ZE0cqnUm4fv165SrPBVHCfMI4TowUfmOfsIcdJh92kBWmUcP6GDt8EDZbzIffH5tx3/ewSFjw5LKk0MEFEkZenDBjgew7Yiog5brkt+QrknvJmhIp4Apw/A1bVpjhG/0v5d7Vrl07bNu2TelUSqUoz8uI3Z49OEtBAy+TdP1CqKtwHzvQUxxgTJs2TeX5gdq1a0ObSmCjh+jB+NuvRamL1+3ls77HCip1rTSdJP5eNnMizKndjMLoH42G4bthX+FzHS3UVVEC69evH3799VeKMXJZrlWKclUGAZ5jxoxB02ZNsNlxH74aagBHZyex986HlVTczyGmI58h4CjL2toa48ePFxsUPEotWrQoc0GT0/C2bduiY8eO4ISMcxLeoOFYhS6qm2EpoZG65jmbv+dPSyRZlt5QfVjvtX19AOFNL+aDFNI4m0eFc9Ho5ORkaGtrl5kAVp6DMOk88efEjLe++ZhclZwHTJHEHbs4YOCmLj2645fdvwnTK42zoXtaEHwNDQ3LXdZm5yad3/2r+gQmDsRnIF5KAldX6zdsgG/GG8F44Vzcu3eP2y1K6GPr2rVrK1zbnz59Or/LoaoJCPZ4kCZsjw9GECL79OmDj9q2wb+320C3/5fgPQO6Vrzh+fpcDqxXr16lbHBwgkZXm6okYJr0ECMrX5vraiJ1lArEjrEnzWuOqemiYj9spGd2ee478XkiPsJakmJ83qA05/8qXNurJFLiunXrhpo1a6LxB02wyHIFZpovgOHwYfjZ0hK2lH5u2rwZ5suWYv5ycyUlmjRpgl69eimlrFy3kwuoyOvXr19frm3RokVMwPZ3TYC57E6xVq+e6KzVDSaL/oEp82Zh8IhhWLjGAp/p9oX5ujVKBNjY2MDV1VWuzd3dXaTesm2biUQuZ8u28elSPmKr8a4vdog8GnJpcT1N1KHUuBbt0jSgWuGbzJh3mVhh2TYHBwdxjFa2jVcZnvPVlQBOLXdZWlqW2ZFxNYYVlm07fPgwAgMD5dr4OD5HeHLFFxM+O42DGtXhIkFaMQlcUjIzM0P37t1Ro0YNpZPjPJcVK7SOjo5ybU5OTqIAo0gAh97VlgAZIj4l8Pn4WFaO64ocuXG6zJtDbMqySnC7IgF8uptLVrJtq1evFuWqak+A4j4i4TNpltiJ8LPiNFFFwNGjRyWFyfedAFUny/joekkEuLi4KK0CfykCeFnkiu1flgBeFtl3/D8SsMbKykpOifv37ysRcPz4cVHKUiSA8wwNdR9/VTMBSh9Y8S4Nf2qnSICiBbDzVCRg9uzZTMC+94kAv6FDh8opwRsVHPjItnl4eEDxHNLKlStFXV+2javQ/M1SpZe+1KA4L4G7WDG57fSm/OUbXiqG0ewAFYOeYcN4fwZhvLkp2y4tftrxcltdlf/w+fPn4qNGxTCYU2m6nrRu3VqunT/EoiuZvw6TTZHpyuNNmEaNGsndP3fu3OJAq1N1JOAHDmyKheVtNP4OkE2crULRAW7fvl20EyyLy24a8p+/7WISFixYIMLt4t82bNhQYjXqXREgPq3j74mlX3AmSL8E1eOPIBXnuVT5OsVZpuLnOMeOHeN7vifwiYhYzhC5IpwlOXj1QXWdBmy/XWU/X+UqMZfKBw4cKAobHPlJlZe9h6tOu+7cuSN2dg0MDMSSyZUpmXvaSD+crq/xvl0k9BTCRa7qEPq+5T4t6ffF52WVV+f1P6zyLG30bsU4AAAAAElFTkSuQmCC">',
      'showdown': '<img width="20" height="20" align="absmiddle" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAsTAAALEwEAmpwYAAAKT2lDQ1BQaG90b3Nob3AgSUNDIHByb2ZpbGUAAHjanVNnVFPpFj333vRCS4iAlEtvUhUIIFJCi4AUkSYqIQkQSoghodkVUcERRUUEG8igiAOOjoCMFVEsDIoK2AfkIaKOg6OIisr74Xuja9a89+bN/rXXPues852zzwfACAyWSDNRNYAMqUIeEeCDx8TG4eQuQIEKJHAAEAizZCFz/SMBAPh+PDwrIsAHvgABeNMLCADATZvAMByH/w/qQplcAYCEAcB0kThLCIAUAEB6jkKmAEBGAYCdmCZTAKAEAGDLY2LjAFAtAGAnf+bTAICd+Jl7AQBblCEVAaCRACATZYhEAGg7AKzPVopFAFgwABRmS8Q5ANgtADBJV2ZIALC3AMDOEAuyAAgMADBRiIUpAAR7AGDIIyN4AISZABRG8lc88SuuEOcqAAB4mbI8uSQ5RYFbCC1xB1dXLh4ozkkXKxQ2YQJhmkAuwnmZGTKBNA/g88wAAKCRFRHgg/P9eM4Ors7ONo62Dl8t6r8G/yJiYuP+5c+rcEAAAOF0ftH+LC+zGoA7BoBt/qIl7gRoXgugdfeLZrIPQLUAoOnaV/Nw+H48PEWhkLnZ2eXk5NhKxEJbYcpXff5nwl/AV/1s+X48/Pf14L7iJIEyXYFHBPjgwsz0TKUcz5IJhGLc5o9H/LcL//wd0yLESWK5WCoU41EScY5EmozzMqUiiUKSKcUl0v9k4t8s+wM+3zUAsGo+AXuRLahdYwP2SycQWHTA4vcAAPK7b8HUKAgDgGiD4c93/+8//UegJQCAZkmScQAAXkQkLlTKsz/HCAAARKCBKrBBG/TBGCzABhzBBdzBC/xgNoRCJMTCQhBCCmSAHHJgKayCQiiGzbAdKmAv1EAdNMBRaIaTcA4uwlW4Dj1wD/phCJ7BKLyBCQRByAgTYSHaiAFiilgjjggXmYX4IcFIBBKLJCDJiBRRIkuRNUgxUopUIFVIHfI9cgI5h1xGupE7yAAygvyGvEcxlIGyUT3UDLVDuag3GoRGogvQZHQxmo8WoJvQcrQaPYw2oefQq2gP2o8+Q8cwwOgYBzPEbDAuxsNCsTgsCZNjy7EirAyrxhqwVqwDu4n1Y8+xdwQSgUXACTYEd0IgYR5BSFhMWE7YSKggHCQ0EdoJNwkDhFHCJyKTqEu0JroR+cQYYjIxh1hILCPWEo8TLxB7iEPENyQSiUMyJ7mQAkmxpFTSEtJG0m5SI+ksqZs0SBojk8naZGuyBzmULCAryIXkneTD5DPkG+Qh8lsKnWJAcaT4U+IoUspqShnlEOU05QZlmDJBVaOaUt2ooVQRNY9aQq2htlKvUYeoEzR1mjnNgxZJS6WtopXTGmgXaPdpr+h0uhHdlR5Ol9BX0svpR+iX6AP0dwwNhhWDx4hnKBmbGAcYZxl3GK+YTKYZ04sZx1QwNzHrmOeZD5lvVVgqtip8FZHKCpVKlSaVGyovVKmqpqreqgtV81XLVI+pXlN9rkZVM1PjqQnUlqtVqp1Q61MbU2epO6iHqmeob1Q/pH5Z/YkGWcNMw09DpFGgsV/jvMYgC2MZs3gsIWsNq4Z1gTXEJrHN2Xx2KruY/R27iz2qqaE5QzNKM1ezUvOUZj8H45hx+Jx0TgnnKKeX836K3hTvKeIpG6Y0TLkxZVxrqpaXllirSKtRq0frvTau7aedpr1Fu1n7gQ5Bx0onXCdHZ4/OBZ3nU9lT3acKpxZNPTr1ri6qa6UbobtEd79up+6Ynr5egJ5Mb6feeb3n+hx9L/1U/W36p/VHDFgGswwkBtsMzhg8xTVxbzwdL8fb8VFDXcNAQ6VhlWGX4YSRudE8o9VGjUYPjGnGXOMk423GbcajJgYmISZLTepN7ppSTbmmKaY7TDtMx83MzaLN1pk1mz0x1zLnm+eb15vft2BaeFostqi2uGVJsuRaplnutrxuhVo5WaVYVVpds0atna0l1rutu6cRp7lOk06rntZnw7Dxtsm2qbcZsOXYBtuutm22fWFnYhdnt8Wuw+6TvZN9un2N/T0HDYfZDqsdWh1+c7RyFDpWOt6azpzuP33F9JbpL2dYzxDP2DPjthPLKcRpnVOb00dnF2e5c4PziIuJS4LLLpc+Lpsbxt3IveRKdPVxXeF60vWdm7Obwu2o26/uNu5p7ofcn8w0nymeWTNz0MPIQ+BR5dE/C5+VMGvfrH5PQ0+BZ7XnIy9jL5FXrdewt6V3qvdh7xc+9j5yn+M+4zw33jLeWV/MN8C3yLfLT8Nvnl+F30N/I/9k/3r/0QCngCUBZwOJgUGBWwL7+Hp8Ib+OPzrbZfay2e1BjKC5QRVBj4KtguXBrSFoyOyQrSH355jOkc5pDoVQfujW0Adh5mGLw34MJ4WHhVeGP45wiFga0TGXNXfR3ENz30T6RJZE3ptnMU85ry1KNSo+qi5qPNo3ujS6P8YuZlnM1VidWElsSxw5LiquNm5svt/87fOH4p3iC+N7F5gvyF1weaHOwvSFpxapLhIsOpZATIhOOJTwQRAqqBaMJfITdyWOCnnCHcJnIi/RNtGI2ENcKh5O8kgqTXqS7JG8NXkkxTOlLOW5hCepkLxMDUzdmzqeFpp2IG0yPTq9MYOSkZBxQqohTZO2Z+pn5mZ2y6xlhbL+xW6Lty8elQfJa7OQrAVZLQq2QqboVFoo1yoHsmdlV2a/zYnKOZarnivN7cyzytuQN5zvn//tEsIS4ZK2pYZLVy0dWOa9rGo5sjxxedsK4xUFK4ZWBqw8uIq2Km3VT6vtV5eufr0mek1rgV7ByoLBtQFr6wtVCuWFfevc1+1dT1gvWd+1YfqGnRs+FYmKrhTbF5cVf9go3HjlG4dvyr+Z3JS0qavEuWTPZtJm6ebeLZ5bDpaql+aXDm4N2dq0Dd9WtO319kXbL5fNKNu7g7ZDuaO/PLi8ZafJzs07P1SkVPRU+lQ27tLdtWHX+G7R7ht7vPY07NXbW7z3/T7JvttVAVVN1WbVZftJ+7P3P66Jqun4lvttXa1ObXHtxwPSA/0HIw6217nU1R3SPVRSj9Yr60cOxx++/p3vdy0NNg1VjZzG4iNwRHnk6fcJ3/ceDTradox7rOEH0x92HWcdL2pCmvKaRptTmvtbYlu6T8w+0dbq3nr8R9sfD5w0PFl5SvNUyWna6YLTk2fyz4ydlZ19fi753GDborZ752PO32oPb++6EHTh0kX/i+c7vDvOXPK4dPKy2+UTV7hXmq86X23qdOo8/pPTT8e7nLuarrlca7nuer21e2b36RueN87d9L158Rb/1tWeOT3dvfN6b/fF9/XfFt1+cif9zsu72Xcn7q28T7xf9EDtQdlD3YfVP1v+3Njv3H9qwHeg89HcR/cGhYPP/pH1jw9DBY+Zj8uGDYbrnjg+OTniP3L96fynQ89kzyaeF/6i/suuFxYvfvjV69fO0ZjRoZfyl5O/bXyl/erA6xmv28bCxh6+yXgzMV70VvvtwXfcdx3vo98PT+R8IH8o/2j5sfVT0Kf7kxmTk/8EA5jz/GMzLdsAAECtaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8P3hwYWNrZXQgYmVnaW49Iu+7vyIgaWQ9Ilc1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCI/Pgo8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJBZG9iZSBYTVAgQ29yZSA1LjYtYzA2NyA3OS4xNTc3NDcsIDIwMTUvMDMvMzAtMjM6NDA6NDIgICAgICAgICI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgICAgICAgICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIgogICAgICAgICAgICB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iCiAgICAgICAgICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgICAgICAgICB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIgogICAgICAgICAgICB4bWxuczpzdFJlZj0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlUmVmIyIKICAgICAgICAgICAgeG1sbnM6dGlmZj0iaHR0cDovL25zLmFkb2JlLmNvbS90aWZmLzEuMC8iCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPHhtcDpDcmVhdG9yVG9vbD5BZG9iZSBQaG90b3Nob3AgQ0MgMjAxNSAoV2luZG93cyk8L3htcDpDcmVhdG9yVG9vbD4KICAgICAgICAgPHhtcDpDcmVhdGVEYXRlPjIwMTUtMDEtMTVUMjE6MDE6MTlaPC94bXA6Q3JlYXRlRGF0ZT4KICAgICAgICAgPHhtcDpNZXRhZGF0YURhdGU+MjAxNy0xMC0yNFQxMzozMTozMCswMTowMDwveG1wOk1ldGFkYXRhRGF0ZT4KICAgICAgICAgPHhtcDpNb2RpZnlEYXRlPjIwMTctMTAtMjRUMTM6MzE6MzArMDE6MDA8L3htcDpNb2RpZnlEYXRlPgogICAgICAgICA8cGhvdG9zaG9wOkNvbG9yTW9kZT4zPC9waG90b3Nob3A6Q29sb3JNb2RlPgogICAgICAgICA8cGhvdG9zaG9wOklDQ1Byb2ZpbGU+c1JHQiBJRUM2MTk2Ni0yLjE8L3Bob3Rvc2hvcDpJQ0NQcm9maWxlPgogICAgICAgICA8cGhvdG9zaG9wOlRleHRMYXllcnM+CiAgICAgICAgICAgIDxyZGY6QmFnPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHBob3Rvc2hvcDpMYXllck5hbWU+UyAtPC9waG90b3Nob3A6TGF5ZXJOYW1lPgogICAgICAgICAgICAgICAgICA8cGhvdG9zaG9wOkxheWVyVGV4dD5TIC08L3Bob3Rvc2hvcDpMYXllclRleHQ+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICA8L3JkZjpCYWc+CiAgICAgICAgIDwvcGhvdG9zaG9wOlRleHRMYXllcnM+CiAgICAgICAgIDxkYzpmb3JtYXQ+aW1hZ2UvcG5nPC9kYzpmb3JtYXQ+CiAgICAgICAgIDx4bXBNTTpJbnN0YW5jZUlEPnhtcC5paWQ6N2NkMzQxNzctOWYyZi0yNDRiLWEyYjQtMzU1MzJkY2Y1MWJiPC94bXBNTTpJbnN0YW5jZUlEPgogICAgICAgICA8eG1wTU06RG9jdW1lbnRJRD5hZG9iZTpkb2NpZDpwaG90b3Nob3A6M2E1YzgxYmYtYjhiNy0xMWU3LTk0NDktYTQ2MzdlZjJkNjMzPC94bXBNTTpEb2N1bWVudElEPgogICAgICAgICA8eG1wTU06T3JpZ2luYWxEb2N1bWVudElEPnhtcC5kaWQ6NjBDNUFFNjVGNjlDRTQxMTk0NUE4NTVFM0JDQTdFRUI8L3htcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD4KICAgICAgICAgPHhtcE1NOkhpc3Rvcnk+CiAgICAgICAgICAgIDxyZGY6U2VxPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmFjdGlvbj5jcmVhdGVkPC9zdEV2dDphY3Rpb24+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDppbnN0YW5jZUlEPnhtcC5paWQ6NjBDNUFFNjVGNjlDRTQxMTk0NUE4NTVFM0JDQTdFRUI8L3N0RXZ0Omluc3RhbmNlSUQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDp3aGVuPjIwMTUtMDEtMTVUMjE6MDE6MTlaPC9zdEV2dDp3aGVuPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6c29mdHdhcmVBZ2VudD5BZG9iZSBQaG90b3Nob3AgQ1M2IChXaW5kb3dzKTwvc3RFdnQ6c29mdHdhcmVBZ2VudD4KICAgICAgICAgICAgICAgPC9yZGY6bGk+CiAgICAgICAgICAgICAgIDxyZGY6bGkgcmRmOnBhcnNlVHlwZT0iUmVzb3VyY2UiPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6YWN0aW9uPnNhdmVkPC9zdEV2dDphY3Rpb24+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDppbnN0YW5jZUlEPnhtcC5paWQ6ODZjNjBkMGQtOGY0Yy01ZTRlLWEwMjQtODI4ZWQyNTIwZDc3PC9zdEV2dDppbnN0YW5jZUlEPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6d2hlbj4yMDE3LTEwLTI0VDEzOjMxOjMwKzAxOjAwPC9zdEV2dDp3aGVuPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6c29mdHdhcmVBZ2VudD5BZG9iZSBQaG90b3Nob3AgQ0MgMjAxNSAoV2luZG93cyk8L3N0RXZ0OnNvZnR3YXJlQWdlbnQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpjaGFuZ2VkPi88L3N0RXZ0OmNoYW5nZWQ+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmFjdGlvbj5jb252ZXJ0ZWQ8L3N0RXZ0OmFjdGlvbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OnBhcmFtZXRlcnM+ZnJvbSBhcHBsaWNhdGlvbi92bmQuYWRvYmUucGhvdG9zaG9wIHRvIGltYWdlL3BuZzwvc3RFdnQ6cGFyYW1ldGVycz4KICAgICAgICAgICAgICAgPC9yZGY6bGk+CiAgICAgICAgICAgICAgIDxyZGY6bGkgcmRmOnBhcnNlVHlwZT0iUmVzb3VyY2UiPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6YWN0aW9uPmRlcml2ZWQ8L3N0RXZ0OmFjdGlvbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OnBhcmFtZXRlcnM+Y29udmVydGVkIGZyb20gYXBwbGljYXRpb24vdm5kLmFkb2JlLnBob3Rvc2hvcCB0byBpbWFnZS9wbmc8L3N0RXZ0OnBhcmFtZXRlcnM+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmFjdGlvbj5zYXZlZDwvc3RFdnQ6YWN0aW9uPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6aW5zdGFuY2VJRD54bXAuaWlkOjdjZDM0MTc3LTlmMmYtMjQ0Yi1hMmI0LTM1NTMyZGNmNTFiYjwvc3RFdnQ6aW5zdGFuY2VJRD4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OndoZW4+MjAxNy0xMC0yNFQxMzozMTozMCswMTowMDwvc3RFdnQ6d2hlbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OnNvZnR3YXJlQWdlbnQ+QWRvYmUgUGhvdG9zaG9wIENDIDIwMTUgKFdpbmRvd3MpPC9zdEV2dDpzb2Z0d2FyZUFnZW50PgogICAgICAgICAgICAgICAgICA8c3RFdnQ6Y2hhbmdlZD4vPC9zdEV2dDpjaGFuZ2VkPgogICAgICAgICAgICAgICA8L3JkZjpsaT4KICAgICAgICAgICAgPC9yZGY6U2VxPgogICAgICAgICA8L3htcE1NOkhpc3Rvcnk+CiAgICAgICAgIDx4bXBNTTpEZXJpdmVkRnJvbSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgIDxzdFJlZjppbnN0YW5jZUlEPnhtcC5paWQ6ODZjNjBkMGQtOGY0Yy01ZTRlLWEwMjQtODI4ZWQyNTIwZDc3PC9zdFJlZjppbnN0YW5jZUlEPgogICAgICAgICAgICA8c3RSZWY6ZG9jdW1lbnRJRD54bXAuZGlkOjYwQzVBRTY1RjY5Q0U0MTE5NDVBODU1RTNCQ0E3RUVCPC9zdFJlZjpkb2N1bWVudElEPgogICAgICAgICAgICA8c3RSZWY6b3JpZ2luYWxEb2N1bWVudElEPnhtcC5kaWQ6NjBDNUFFNjVGNjlDRTQxMTk0NUE4NTVFM0JDQTdFRUI8L3N0UmVmOm9yaWdpbmFsRG9jdW1lbnRJRD4KICAgICAgICAgPC94bXBNTTpEZXJpdmVkRnJvbT4KICAgICAgICAgPHRpZmY6T3JpZW50YXRpb24+MTwvdGlmZjpPcmllbnRhdGlvbj4KICAgICAgICAgPHRpZmY6WFJlc29sdXRpb24+NzIwMDAwLzEwMDAwPC90aWZmOlhSZXNvbHV0aW9uPgogICAgICAgICA8dGlmZjpZUmVzb2x1dGlvbj43MjAwMDAvMTAwMDA8L3RpZmY6WVJlc29sdXRpb24+CiAgICAgICAgIDx0aWZmOlJlc29sdXRpb25Vbml0PjI8L3RpZmY6UmVzb2x1dGlvblVuaXQ+CiAgICAgICAgIDxleGlmOkNvbG9yU3BhY2U+MTwvZXhpZjpDb2xvclNwYWNlPgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+NjQ8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+NjQ8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/Pse7bzcAAAAgY0hSTQAAeiUAAICDAAD5/wAAgOkAAHUwAADqYAAAOpgAABdvkl/FRgAAA1JJREFUeNrsm1+OmlAUhz+aeS9dwZggJn1AnRUMO6jpBgZXULuC2hWUWUGZBTSxKyiuoA4mfUBMnB04K5g+9DihRBHlyh/lJLwIXLgf99xzzu9etZeXFy7Z3nDh1gBoAFy4XeVtQNO0zNcapmUDfUBPnFoBfhQGq6IBaHmjwD4Ahmk5wAD4kKG5J8CNwsAFaHe6DvA9cc0wCgOv8gDka3vA9RHNPgo0D7hNnJtGYWBXxgV2dH4MfMnRRA+Y1WIO2NJ5F/ikoKm3tYsChmkNFHW+fmHQMC1dfHaXPQP3wM1yMdc2B/AOGALTWobBmI1Shu0UGCwX83XyRBQGawHntTtdG5gUNfxVu4CTNqNv6/wWGL7kCc+1AmCYVisl3I2ydD4GYZUCs7IjoLXrxHIx9w9tLAqDCfBwDrXAY457x+cAoCfuwRGjYFUnAGk+PsjR7s8Dn1VeLWCYVlpDw+VivjVHSHt+u9PVJbzGzZXQWTkAkz0V31fATUaEsjVJlQBs4FeGcteLgzgbAALBA+4y3voAeJL8nA0AHfClnM1qm1HhnYUidCSE+KzvSSJUTwAxCOMcpfETMFYpfRUKIAbCFhC3OTJJJwqDWS0BxED0JZ4Pjix1P2+E0loCSMBwyK4S/xc1ojBwag8gMU84cvTKGgmlAYhngu1O9xAXuVE5J1QCQCz3bwHuHvdQui5QKQAxEO6eEKpsFCgTRSXkvdoxSlBMCxhJJbgrrbZRtHCiShN0pRB6PeQ3ckBw2K0oKXMBVYJIP+Nvh9qulFivGoBt1lLQxowT2ykBXCfnhZIglgYACWmqXQv+baioBYCeiCQHm+QEg1O7RhF7hO4OhSAhcJKSFU7qBGADwZeqMMuXn6TUBw8qlaMrirNb4LdhWlP+SWD+cjFfxTpuS2GUpik+o3jFSEkqbJiWn0P0OMSGqlWiOu0TvD+FRHZKAE+oW+cfRmEwqlsesJJEJs8y91QqP+9UL6lqEtz2gpuNEY5sm9sIHln2DRa2aFKGJtiXkZEMiWtgVvRKUSUFkSKt2S7fAGgAXLYpmQQXf36MUChTZdUa2u8/rkvPA6Tz30r4eH3ybcBS5gJ6SaNXb+aABkA1AMxKenclBZLW/He4cYEGwEXb3wEASelexk6LIIIAAAAASUVORK5CYII=">'
    };

    /**
     * Created by Estevao on 31-05-2015.
     */

    /**
     * Showdown Converter class
     * @class
     * @param {object} [converterOptions]
     * @returns {Converter}
     */
    showdown.Converter = function (converterOptions) {

      var
          /**
           * Options used by this converter
           * @private
           * @type {{}}
           */
          options = {},

          /**
           * Language extensions used by this converter
           * @private
           * @type {Array}
           */
          langExtensions = [],

          /**
           * Output modifiers extensions used by this converter
           * @private
           * @type {Array}
           */
          outputModifiers = [],

          /**
           * Event listeners
           * @private
           * @type {{}}
           */
          listeners = {},

          /**
           * The flavor set in this converter
           */
          setConvFlavor = setFlavor,

        /**
         * Metadata of the document
         * @type {{parsed: {}, raw: string, format: string}}
         */
          metadata = {
            parsed: {},
            raw: '',
            format: ''
          };

      _constructor();

      /**
       * Converter constructor
       * @private
       */
      function _constructor () {
        converterOptions = converterOptions || {};

        for (var gOpt in globalOptions) {
          if (globalOptions.hasOwnProperty(gOpt)) {
            options[gOpt] = globalOptions[gOpt];
          }
        }

        // Merge options
        if (typeof converterOptions === 'object') {
          for (var opt in converterOptions) {
            if (converterOptions.hasOwnProperty(opt)) {
              options[opt] = converterOptions[opt];
            }
          }
        } else {
          throw Error('Converter expects the passed parameter to be an object, but ' + typeof converterOptions +
          ' was passed instead.');
        }

        if (options.extensions) {
          showdown.helper.forEach(options.extensions, _parseExtension);
        }
      }

      /**
       * Parse extension
       * @param {*} ext
       * @param {string} [name='']
       * @private
       */
      function _parseExtension (ext, name) {

        name = name || null;
        // If it's a string, the extension was previously loaded
        if (showdown.helper.isString(ext)) {
          ext = showdown.helper.stdExtName(ext);
          name = ext;

          // LEGACY_SUPPORT CODE
          if (showdown.extensions[ext]) {
            console.warn('DEPRECATION WARNING: ' + ext + ' is an old extension that uses a deprecated loading method.' +
              'Please inform the developer that the extension should be updated!');
            legacyExtensionLoading(showdown.extensions[ext], ext);
            return;
          // END LEGACY SUPPORT CODE

          } else if (!showdown.helper.isUndefined(extensions[ext])) {
            ext = extensions[ext];

          } else {
            throw Error('Extension "' + ext + '" could not be loaded. It was either not found or is not a valid extension.');
          }
        }

        if (typeof ext === 'function') {
          ext = ext();
        }

        if (!showdown.helper.isArray(ext)) {
          ext = [ext];
        }

        var validExt = validate(ext, name);
        if (!validExt.valid) {
          throw Error(validExt.error);
        }

        for (var i = 0; i < ext.length; ++i) {
          switch (ext[i].type) {

            case 'lang':
              langExtensions.push(ext[i]);
              break;

            case 'output':
              outputModifiers.push(ext[i]);
              break;
          }
          if (ext[i].hasOwnProperty('listeners')) {
            for (var ln in ext[i].listeners) {
              if (ext[i].listeners.hasOwnProperty(ln)) {
                listen(ln, ext[i].listeners[ln]);
              }
            }
          }
        }

      }

      /**
       * LEGACY_SUPPORT
       * @param {*} ext
       * @param {string} name
       */
      function legacyExtensionLoading (ext, name) {
        if (typeof ext === 'function') {
          ext = ext(new showdown.Converter());
        }
        if (!showdown.helper.isArray(ext)) {
          ext = [ext];
        }
        var valid = validate(ext, name);

        if (!valid.valid) {
          throw Error(valid.error);
        }

        for (var i = 0; i < ext.length; ++i) {
          switch (ext[i].type) {
            case 'lang':
              langExtensions.push(ext[i]);
              break;
            case 'output':
              outputModifiers.push(ext[i]);
              break;
            default:// should never reach here
              throw Error('Extension loader error: Type unrecognized!!!');
          }
        }
      }

      /**
       * Listen to an event
       * @param {string} name
       * @param {function} callback
       */
      function listen (name, callback) {
        if (!showdown.helper.isString(name)) {
          throw Error('Invalid argument in converter.listen() method: name must be a string, but ' + typeof name + ' given');
        }

        if (typeof callback !== 'function') {
          throw Error('Invalid argument in converter.listen() method: callback must be a function, but ' + typeof callback + ' given');
        }

        if (!listeners.hasOwnProperty(name)) {
          listeners[name] = [];
        }
        listeners[name].push(callback);
      }

      function rTrimInputText (text) {
        var rsp = text.match(/^\s*/)[0].length,
            rgx = new RegExp('^\\s{0,' + rsp + '}', 'gm');
        return text.replace(rgx, '');
      }

      /**
       * Dispatch an event
       * @private
       * @param {string} evtName Event name
       * @param {string} text Text
       * @param {{}} options Converter Options
       * @param {{}} globals
       * @returns {string}
       */
      this._dispatch = function dispatch (evtName, text, options, globals) {
        if (listeners.hasOwnProperty(evtName)) {
          for (var ei = 0; ei < listeners[evtName].length; ++ei) {
            var nText = listeners[evtName][ei](evtName, text, this, options, globals);
            if (nText && typeof nText !== 'undefined') {
              text = nText;
            }
          }
        }
        return text;
      };

      /**
       * Listen to an event
       * @param {string} name
       * @param {function} callback
       * @returns {showdown.Converter}
       */
      this.listen = function (name, callback) {
        listen(name, callback);
        return this;
      };

      /**
       * Converts a markdown string into HTML
       * @param {string} text
       * @returns {*}
       */
      this.makeHtml = function (text) {
        //check if text is not falsy
        if (!text) {
          return text;
        }

        var globals = {
          gHtmlBlocks:     [],
          gHtmlMdBlocks:   [],
          gHtmlSpans:      [],
          gUrls:           {},
          gTitles:         {},
          gDimensions:     {},
          gListLevel:      0,
          hashLinkCounts:  {},
          langExtensions:  langExtensions,
          outputModifiers: outputModifiers,
          converter:       this,
          ghCodeBlocks:    [],
          metadata: {
            parsed: {},
            raw: '',
            format: ''
          }
        };

        // This lets us use ¨ trema as an escape char to avoid md5 hashes
        // The choice of character is arbitrary; anything that isn't
        // magic in Markdown will work.
        text = text.replace(/¨/g, '¨T');

        // Replace $ with ¨D
        // RegExp interprets $ as a special character
        // when it's in a replacement string
        text = text.replace(/\$/g, '¨D');

        // Standardize line endings
        text = text.replace(/\r\n/g, '\n'); // DOS to Unix
        text = text.replace(/\r/g, '\n'); // Mac to Unix

        // Stardardize line spaces (nbsp causes trouble in older browsers and some regex flavors)
        text = text.replace(/\u00A0/g, ' ');

        if (options.smartIndentationFix) {
          text = rTrimInputText(text);
        }

        // Make sure text begins and ends with a couple of newlines:
        text = '\n\n' + text + '\n\n';

        // detab
        text = showdown.subParser('detab')(text, options, globals);

        /**
         * Strip any lines consisting only of spaces and tabs.
         * This makes subsequent regexs easier to write, because we can
         * match consecutive blank lines with /\n+/ instead of something
         * contorted like /[ \t]*\n+/
         */
        text = text.replace(/^[ \t]+$/mg, '');

        //run languageExtensions
        showdown.helper.forEach(langExtensions, function (ext) {
          text = showdown.subParser('runExtension')(ext, text, options, globals);
        });

        // run the sub parsers
        text = showdown.subParser('metadata')(text, options, globals);
        text = showdown.subParser('hashPreCodeTags')(text, options, globals);
        text = showdown.subParser('githubCodeBlocks')(text, options, globals);
        text = showdown.subParser('hashHTMLBlocks')(text, options, globals);
        text = showdown.subParser('hashCodeTags')(text, options, globals);
        text = showdown.subParser('stripLinkDefinitions')(text, options, globals);
        text = showdown.subParser('blockGamut')(text, options, globals);
        text = showdown.subParser('unhashHTMLSpans')(text, options, globals);
        text = showdown.subParser('unescapeSpecialChars')(text, options, globals);

        // attacklab: Restore dollar signs
        text = text.replace(/¨D/g, '$$');

        // attacklab: Restore tremas
        text = text.replace(/¨T/g, '¨');

        // render a complete html document instead of a partial if the option is enabled
        text = showdown.subParser('completeHTMLDocument')(text, options, globals);

        // Run output modifiers
        showdown.helper.forEach(outputModifiers, function (ext) {
          text = showdown.subParser('runExtension')(ext, text, options, globals);
        });

        // update metadata
        metadata = globals.metadata;
        return text;
      };

      /**
       * Set an option of this Converter instance
       * @param {string} key
       * @param {*} value
       */
      this.setOption = function (key, value) {
        options[key] = value;
      };

      /**
       * Get the option of this Converter instance
       * @param {string} key
       * @returns {*}
       */
      this.getOption = function (key) {
        return options[key];
      };

      /**
       * Get the options of this Converter instance
       * @returns {{}}
       */
      this.getOptions = function () {
        return options;
      };

      /**
       * Add extension to THIS converter
       * @param {{}} extension
       * @param {string} [name=null]
       */
      this.addExtension = function (extension, name) {
        name = name || null;
        _parseExtension(extension, name);
      };

      /**
       * Use a global registered extension with THIS converter
       * @param {string} extensionName Name of the previously registered extension
       */
      this.useExtension = function (extensionName) {
        _parseExtension(extensionName);
      };

      /**
       * Set the flavor THIS converter should use
       * @param {string} name
       */
      this.setFlavor = function (name) {
        if (!flavor.hasOwnProperty(name)) {
          throw Error(name + ' flavor was not found');
        }
        var preset = flavor[name];
        setConvFlavor = name;
        for (var option in preset) {
          if (preset.hasOwnProperty(option)) {
            options[option] = preset[option];
          }
        }
      };

      /**
       * Get the currently set flavor of this converter
       * @returns {string}
       */
      this.getFlavor = function () {
        return setConvFlavor;
      };

      /**
       * Remove an extension from THIS converter.
       * Note: This is a costly operation. It's better to initialize a new converter
       * and specify the extensions you wish to use
       * @param {Array} extension
       */
      this.removeExtension = function (extension) {
        if (!showdown.helper.isArray(extension)) {
          extension = [extension];
        }
        for (var a = 0; a < extension.length; ++a) {
          var ext = extension[a];
          for (var i = 0; i < langExtensions.length; ++i) {
            if (langExtensions[i] === ext) {
              langExtensions[i].splice(i, 1);
            }
          }
          for (var ii = 0; ii < outputModifiers.length; ++i) {
            if (outputModifiers[ii] === ext) {
              outputModifiers[ii].splice(i, 1);
            }
          }
        }
      };

      /**
       * Get all extension of THIS converter
       * @returns {{language: Array, output: Array}}
       */
      this.getAllExtensions = function () {
        return {
          language: langExtensions,
          output: outputModifiers
        };
      };

      /**
       * Get the metadata of the previously parsed document
       * @param raw
       * @returns {string|{}}
       */
      this.getMetadata = function (raw) {
        if (raw) {
          return metadata.raw;
        } else {
          return metadata.parsed;
        }
      };

      /**
       * Get the metadata format of the previously parsed document
       * @returns {string}
       */
      this.getMetadataFormat = function () {
        return metadata.format;
      };

      /**
       * Private: set a single key, value metadata pair
       * @param {string} key
       * @param {string} value
       */
      this._setMetadataPair = function (key, value) {
        metadata.parsed[key] = value;
      };

      /**
       * Private: set metadata format
       * @param {string} format
       */
      this._setMetadataFormat = function (format) {
        metadata.format = format;
      };

      /**
       * Private: set metadata raw text
       * @param {string} raw
       */
      this._setMetadataRaw = function (raw) {
        metadata.raw = raw;
      };
    };

    /**
     * Turn Markdown link shortcuts into XHTML <a> tags.
     */
    showdown.subParser('anchors', function (text, options, globals) {

      text = globals.converter._dispatch('anchors.before', text, options, globals);

      var writeAnchorTag = function (wholeMatch, linkText, linkId, url, m5, m6, title) {
        if (showdown.helper.isUndefined(title)) {
          title = '';
        }
        linkId = linkId.toLowerCase();

        // Special case for explicit empty url
        if (wholeMatch.search(/\(<?\s*>? ?(['"].*['"])?\)$/m) > -1) {
          url = '';
        } else if (!url) {
          if (!linkId) {
            // lower-case and turn embedded newlines into spaces
            linkId = linkText.toLowerCase().replace(/ ?\n/g, ' ');
          }
          url = '#' + linkId;

          if (!showdown.helper.isUndefined(globals.gUrls[linkId])) {
            url = globals.gUrls[linkId];
            if (!showdown.helper.isUndefined(globals.gTitles[linkId])) {
              title = globals.gTitles[linkId];
            }
          } else {
            return wholeMatch;
          }
        }

        //url = showdown.helper.escapeCharacters(url, '*_', false); // replaced line to improve performance
        url = url.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);

        var result = '<a href="' + url + '"';

        if (title !== '' && title !== null) {
          title = title.replace(/"/g, '&quot;');
          //title = showdown.helper.escapeCharacters(title, '*_', false); // replaced line to improve performance
          title = title.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
          result += ' title="' + title + '"';
        }

        // optionLinksInNewWindow only applies
        // to external links. Hash links (#) open in same page
        if (options.openLinksInNewWindow && !/^#/.test(url)) {
          // escaped _
          result += ' target="¨E95Eblank"';
        }

        result += '>' + linkText + '</a>';

        return result;
      };

      // First, handle reference-style links: [link text] [id]
      text = text.replace(/\[((?:\[[^\]]*]|[^\[\]])*)] ?(?:\n *)?\[(.*?)]()()()()/g, writeAnchorTag);

      // Next, inline-style links: [link text](url "optional title")
      // cases with crazy urls like ./image/cat1).png
      text = text.replace(/\[((?:\[[^\]]*]|[^\[\]])*)]()[ \t]*\([ \t]?<([^>]*)>(?:[ \t]*((["'])([^"]*?)\5))?[ \t]?\)/g,
        writeAnchorTag);

      // normal cases
      text = text.replace(/\[((?:\[[^\]]*]|[^\[\]])*)]()[ \t]*\([ \t]?<?([\S]+?(?:\([\S]*?\)[\S]*?)?)>?(?:[ \t]*((["'])([^"]*?)\5))?[ \t]?\)/g,
                          writeAnchorTag);

      // handle reference-style shortcuts: [link text]
      // These must come last in case you've also got [link test][1]
      // or [link test](/foo)
      text = text.replace(/\[([^\[\]]+)]()()()()()/g, writeAnchorTag);

      // Lastly handle GithubMentions if option is enabled
      if (options.ghMentions) {
        text = text.replace(/(^|\s)(\\)?(@([a-z\d\-]+))(?=[.!?;,[\]()]|\s|$)/gmi, function (wm, st, escape, mentions, username) {
          if (escape === '\\') {
            return st + mentions;
          }

          //check if options.ghMentionsLink is a string
          if (!showdown.helper.isString(options.ghMentionsLink)) {
            throw new Error('ghMentionsLink option must be a string');
          }
          var lnk = options.ghMentionsLink.replace(/\{u}/g, username),
              target = '';
          if (options.openLinksInNewWindow) {
            target = ' target="¨E95Eblank"';
          }
          return st + '<a href="' + lnk + '"' + target + '>' + mentions + '</a>';
        });
      }

      text = globals.converter._dispatch('anchors.after', text, options, globals);
      return text;
    });

    // url allowed chars [a-z\d_.~:/?#[]@!$&'()*+,;=-]

    var simpleURLRegex  = /([*~_]+|\b)(((https?|ftp|dict):\/\/|www\.)[^'">\s]+?\.[^'">\s]+?)()(\1)?(?=\s|$)(?!["<>])/gi,
        simpleURLRegex2 = /([*~_]+|\b)(((https?|ftp|dict):\/\/|www\.)[^'">\s]+\.[^'">\s]+?)([.!?,()\[\]])?(\1)?(?=\s|$)(?!["<>])/gi,
        delimUrlRegex   = /()<(((https?|ftp|dict):\/\/|www\.)[^'">\s]+)()>()/gi,
        simpleMailRegex = /(^|\s)(?:mailto:)?([A-Za-z0-9!#$%&'*+-/=?^_`{|}~.]+@[-a-z0-9]+(\.[-a-z0-9]+)*\.[a-z]+)(?=$|\s)/gmi,
        delimMailRegex  = /<()(?:mailto:)?([-.\w]+@[-a-z0-9]+(\.[-a-z0-9]+)*\.[a-z]+)>/gi,

        replaceLink = function (options) {
          return function (wm, leadingMagicChars, link, m2, m3, trailingPunctuation, trailingMagicChars) {
            link = link.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
            var lnkTxt = link,
                append = '',
                target = '',
                lmc    = leadingMagicChars || '',
                tmc    = trailingMagicChars || '';
            if (/^www\./i.test(link)) {
              link = link.replace(/^www\./i, 'http://www.');
            }
            if (options.excludeTrailingPunctuationFromURLs && trailingPunctuation) {
              append = trailingPunctuation;
            }
            if (options.openLinksInNewWindow) {
              target = ' target="¨E95Eblank"';
            }
            return lmc + '<a href="' + link + '"' + target + '>' + lnkTxt + '</a>' + append + tmc;
          };
        },

        replaceMail = function (options, globals) {
          return function (wholeMatch, b, mail) {
            var href = 'mailto:';
            b = b || '';
            mail = showdown.subParser('unescapeSpecialChars')(mail, options, globals);
            if (options.encodeEmails) {
              href = showdown.helper.encodeEmailAddress(href + mail);
              mail = showdown.helper.encodeEmailAddress(mail);
            } else {
              href = href + mail;
            }
            return b + '<a href="' + href + '">' + mail + '</a>';
          };
        };

    showdown.subParser('autoLinks', function (text, options, globals) {

      text = globals.converter._dispatch('autoLinks.before', text, options, globals);

      text = text.replace(delimUrlRegex, replaceLink(options));
      text = text.replace(delimMailRegex, replaceMail(options, globals));

      text = globals.converter._dispatch('autoLinks.after', text, options, globals);

      return text;
    });

    showdown.subParser('simplifiedAutoLinks', function (text, options, globals) {

      if (!options.simplifiedAutoLink) {
        return text;
      }

      text = globals.converter._dispatch('simplifiedAutoLinks.before', text, options, globals);

      if (options.excludeTrailingPunctuationFromURLs) {
        text = text.replace(simpleURLRegex2, replaceLink(options));
      } else {
        text = text.replace(simpleURLRegex, replaceLink(options));
      }
      text = text.replace(simpleMailRegex, replaceMail(options, globals));

      text = globals.converter._dispatch('simplifiedAutoLinks.after', text, options, globals);

      return text;
    });

    /**
     * These are all the transformations that form block-level
     * tags like paragraphs, headers, and list items.
     */
    showdown.subParser('blockGamut', function (text, options, globals) {

      text = globals.converter._dispatch('blockGamut.before', text, options, globals);

      // we parse blockquotes first so that we can have headings and hrs
      // inside blockquotes
      text = showdown.subParser('blockQuotes')(text, options, globals);
      text = showdown.subParser('headers')(text, options, globals);

      // Do Horizontal Rules:
      text = showdown.subParser('horizontalRule')(text, options, globals);

      text = showdown.subParser('lists')(text, options, globals);
      text = showdown.subParser('codeBlocks')(text, options, globals);
      text = showdown.subParser('tables')(text, options, globals);

      // We already ran _HashHTMLBlocks() before, in Markdown(), but that
      // was to escape raw HTML in the original Markdown source. This time,
      // we're escaping the markup we've just created, so that we don't wrap
      // <p> tags around block-level tags.
      text = showdown.subParser('hashHTMLBlocks')(text, options, globals);
      text = showdown.subParser('paragraphs')(text, options, globals);

      text = globals.converter._dispatch('blockGamut.after', text, options, globals);

      return text;
    });

    showdown.subParser('blockQuotes', function (text, options, globals) {

      text = globals.converter._dispatch('blockQuotes.before', text, options, globals);

      // add a couple extra lines after the text and endtext mark
      text = text + '\n\n';

      var rgx = /(^ {0,3}>[ \t]?.+\n(.+\n)*\n*)+/gm;

      if (options.splitAdjacentBlockquotes) {
        rgx = /^ {0,3}>[\s\S]*?(?:\n\n)/gm;
      }

      text = text.replace(rgx, function (bq) {
        // attacklab: hack around Konqueror 3.5.4 bug:
        // "----------bug".replace(/^-/g,"") == "bug"
        bq = bq.replace(/^[ \t]*>[ \t]?/gm, ''); // trim one level of quoting

        // attacklab: clean up hack
        bq = bq.replace(/¨0/g, '');

        bq = bq.replace(/^[ \t]+$/gm, ''); // trim whitespace-only lines
        bq = showdown.subParser('githubCodeBlocks')(bq, options, globals);
        bq = showdown.subParser('blockGamut')(bq, options, globals); // recurse

        bq = bq.replace(/(^|\n)/g, '$1  ');
        // These leading spaces screw with <pre> content, so we need to fix that:
        bq = bq.replace(/(\s*<pre>[^\r]+?<\/pre>)/gm, function (wholeMatch, m1) {
          var pre = m1;
          // attacklab: hack around Konqueror 3.5.4 bug:
          pre = pre.replace(/^  /mg, '¨0');
          pre = pre.replace(/¨0/g, '');
          return pre;
        });

        return showdown.subParser('hashBlock')('<blockquote>\n' + bq + '\n</blockquote>', options, globals);
      });

      text = globals.converter._dispatch('blockQuotes.after', text, options, globals);
      return text;
    });

    /**
     * Process Markdown `<pre><code>` blocks.
     */
    showdown.subParser('codeBlocks', function (text, options, globals) {

      text = globals.converter._dispatch('codeBlocks.before', text, options, globals);

      // sentinel workarounds for lack of \A and \Z, safari\khtml bug
      text += '¨0';

      var pattern = /(?:\n\n|^)((?:(?:[ ]{4}|\t).*\n+)+)(\n*[ ]{0,3}[^ \t\n]|(?=¨0))/g;
      text = text.replace(pattern, function (wholeMatch, m1, m2) {
        var codeblock = m1,
            nextChar = m2,
            end = '\n';

        codeblock = showdown.subParser('outdent')(codeblock, options, globals);
        codeblock = showdown.subParser('encodeCode')(codeblock, options, globals);
        codeblock = showdown.subParser('detab')(codeblock, options, globals);
        codeblock = codeblock.replace(/^\n+/g, ''); // trim leading newlines
        codeblock = codeblock.replace(/\n+$/g, ''); // trim trailing newlines

        if (options.omitExtraWLInCodeBlocks) {
          end = '';
        }

        codeblock = '<pre><code>' + codeblock + end + '</code></pre>';

        return showdown.subParser('hashBlock')(codeblock, options, globals) + nextChar;
      });

      // strip sentinel
      text = text.replace(/¨0/, '');

      text = globals.converter._dispatch('codeBlocks.after', text, options, globals);
      return text;
    });

    /**
     *
     *   *  Backtick quotes are used for <code></code> spans.
     *
     *   *  You can use multiple backticks as the delimiters if you want to
     *     include literal backticks in the code span. So, this input:
     *
     *         Just type ``foo `bar` baz`` at the prompt.
     *
     *       Will translate to:
     *
     *         <p>Just type <code>foo `bar` baz</code> at the prompt.</p>
     *
     *    There's no arbitrary limit to the number of backticks you
     *    can use as delimters. If you need three consecutive backticks
     *    in your code, use four for delimiters, etc.
     *
     *  *  You can use spaces to get literal backticks at the edges:
     *
     *         ... type `` `bar` `` ...
     *
     *       Turns to:
     *
     *         ... type <code>`bar`</code> ...
     */
    showdown.subParser('codeSpans', function (text, options, globals) {

      text = globals.converter._dispatch('codeSpans.before', text, options, globals);

      if (typeof(text) === 'undefined') {
        text = '';
      }
      text = text.replace(/(^|[^\\])(`+)([^\r]*?[^`])\2(?!`)/gm,
        function (wholeMatch, m1, m2, m3) {
          var c = m3;
          c = c.replace(/^([ \t]*)/g, '');	// leading whitespace
          c = c.replace(/[ \t]*$/g, '');	// trailing whitespace
          c = showdown.subParser('encodeCode')(c, options, globals);
          c = m1 + '<code>' + c + '</code>';
          c = showdown.subParser('hashHTMLSpans')(c, options, globals);
          return c;
        }
      );

      text = globals.converter._dispatch('codeSpans.after', text, options, globals);
      return text;
    });

    /**
     * Turn Markdown link shortcuts into XHTML <a> tags.
     */
    showdown.subParser('completeHTMLDocument', function (text, options, globals) {

      if (!options.completeHTMLDocument) {
        return text;
      }

      text = globals.converter._dispatch('completeHTMLDocument.before', text, options, globals);

      var doctype = 'html',
          doctypeParsed = '<!DOCTYPE HTML>\n',
          title = '',
          charset = '<meta charset="utf-8">\n',
          lang = '',
          metadata = '';

      if (typeof globals.metadata.parsed.doctype !== 'undefined') {
        doctypeParsed = '<!DOCTYPE ' +  globals.metadata.parsed.doctype + '>\n';
        doctype = globals.metadata.parsed.doctype.toString().toLowerCase();
        if (doctype === 'html' || doctype === 'html5') {
          charset = '<meta charset="utf-8">';
        }
      }

      for (var meta in globals.metadata.parsed) {
        if (globals.metadata.parsed.hasOwnProperty(meta)) {
          switch (meta.toLowerCase()) {
            case 'doctype':
              break;

            case 'title':
              title = '<title>' +  globals.metadata.parsed.title + '</title>\n';
              break;

            case 'charset':
              if (doctype === 'html' || doctype === 'html5') {
                charset = '<meta charset="' + globals.metadata.parsed.charset + '">\n';
              } else {
                charset = '<meta name="charset" content="' + globals.metadata.parsed.charset + '">\n';
              }
              break;

            case 'language':
            case 'lang':
              lang = ' lang="' + globals.metadata.parsed[meta] + '"';
              metadata += '<meta name="' + meta + '" content="' + globals.metadata.parsed[meta] + '">\n';
              break;

            default:
              metadata += '<meta name="' + meta + '" content="' + globals.metadata.parsed[meta] + '">\n';
          }
        }
      }

      text = doctypeParsed + '<html' + lang + '>\n<head>\n' + title + charset + metadata + '</head>\n<body>\n' + text.trim() + '\n</body>\n</html>';

      text = globals.converter._dispatch('completeHTMLDocument.after', text, options, globals);
      return text;
    });

    /**
     * Convert all tabs to spaces
     */
    showdown.subParser('detab', function (text, options, globals) {
      text = globals.converter._dispatch('detab.before', text, options, globals);

      // expand first n-1 tabs
      text = text.replace(/\t(?=\t)/g, '    '); // g_tab_width

      // replace the nth with two sentinels
      text = text.replace(/\t/g, '¨A¨B');

      // use the sentinel to anchor our regex so it doesn't explode
      text = text.replace(/¨B(.+?)¨A/g, function (wholeMatch, m1) {
        var leadingText = m1,
            numSpaces = 4 - leadingText.length % 4;  // g_tab_width

        // there *must* be a better way to do this:
        for (var i = 0; i < numSpaces; i++) {
          leadingText += ' ';
        }

        return leadingText;
      });

      // clean up sentinels
      text = text.replace(/¨A/g, '    ');  // g_tab_width
      text = text.replace(/¨B/g, '');

      text = globals.converter._dispatch('detab.after', text, options, globals);
      return text;
    });

    showdown.subParser('ellipsis', function (text, options, globals) {

      text = globals.converter._dispatch('ellipsis.before', text, options, globals);

      text = text.replace(/\.\.\./g, '…');

      text = globals.converter._dispatch('ellipsis.after', text, options, globals);

      return text;
    });

    /**
     * These are all the transformations that occur *within* block-level
     * tags like paragraphs, headers, and list items.
     */
    showdown.subParser('emoji', function (text, options, globals) {

      if (!options.emoji) {
        return text;
      }

      text = globals.converter._dispatch('emoji.before', text, options, globals);

      var emojiRgx = /:([\S]+?):/g;

      text = text.replace(emojiRgx, function (wm, emojiCode) {
        if (showdown.helper.emojis.hasOwnProperty(emojiCode)) {
          return showdown.helper.emojis[emojiCode];
        }
        return wm;
      });

      text = globals.converter._dispatch('emoji.after', text, options, globals);

      return text;
    });

    /**
     * Smart processing for ampersands and angle brackets that need to be encoded.
     */
    showdown.subParser('encodeAmpsAndAngles', function (text, options, globals) {
      text = globals.converter._dispatch('encodeAmpsAndAngles.before', text, options, globals);

      // Ampersand-encoding based entirely on Nat Irons's Amputator MT plugin:
      // http://bumppo.net/projects/amputator/
      text = text.replace(/&(?!#?[xX]?(?:[0-9a-fA-F]+|\w+);)/g, '&amp;');

      // Encode naked <'s
      text = text.replace(/<(?![a-z\/?$!])/gi, '&lt;');

      // Encode <
      text = text.replace(/</g, '&lt;');

      // Encode >
      text = text.replace(/>/g, '&gt;');

      text = globals.converter._dispatch('encodeAmpsAndAngles.after', text, options, globals);
      return text;
    });

    /**
     * Returns the string, with after processing the following backslash escape sequences.
     *
     * attacklab: The polite way to do this is with the new escapeCharacters() function:
     *
     *    text = escapeCharacters(text,"\\",true);
     *    text = escapeCharacters(text,"`*_{}[]()>#+-.!",true);
     *
     * ...but we're sidestepping its use of the (slow) RegExp constructor
     * as an optimization for Firefox.  This function gets called a LOT.
     */
    showdown.subParser('encodeBackslashEscapes', function (text, options, globals) {
      text = globals.converter._dispatch('encodeBackslashEscapes.before', text, options, globals);

      text = text.replace(/\\(\\)/g, showdown.helper.escapeCharactersCallback);
      text = text.replace(/\\([`*_{}\[\]()>#+.!~=|-])/g, showdown.helper.escapeCharactersCallback);

      text = globals.converter._dispatch('encodeBackslashEscapes.after', text, options, globals);
      return text;
    });

    /**
     * Encode/escape certain characters inside Markdown code runs.
     * The point is that in code, these characters are literals,
     * and lose their special Markdown meanings.
     */
    showdown.subParser('encodeCode', function (text, options, globals) {

      text = globals.converter._dispatch('encodeCode.before', text, options, globals);

      // Encode all ampersands; HTML entities are not
      // entities within a Markdown code span.
      text = text
        .replace(/&/g, '&amp;')
      // Do the angle bracket song and dance:
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      // Now, escape characters that are magic in Markdown:
        .replace(/([*_{}\[\]\\=~-])/g, showdown.helper.escapeCharactersCallback);

      text = globals.converter._dispatch('encodeCode.after', text, options, globals);
      return text;
    });

    /**
     * Within tags -- meaning between < and > -- encode [\ ` * _ ~ =] so they
     * don't conflict with their use in Markdown for code, italics and strong.
     */
    showdown.subParser('escapeSpecialCharsWithinTagAttributes', function (text, options, globals) {
      text = globals.converter._dispatch('escapeSpecialCharsWithinTagAttributes.before', text, options, globals);

      // Build a regex to find HTML tags.
      var tags     = /<\/?[a-z\d_:-]+(?:[\s]+[\s\S]+?)?>/gi,
          comments = /<!(--(?:(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)>/gi;

      text = text.replace(tags, function (wholeMatch) {
        return wholeMatch
          .replace(/(.)<\/?code>(?=.)/g, '$1`')
          .replace(/([\\`*_~=|])/g, showdown.helper.escapeCharactersCallback);
      });

      text = text.replace(comments, function (wholeMatch) {
        return wholeMatch
          .replace(/([\\`*_~=|])/g, showdown.helper.escapeCharactersCallback);
      });

      text = globals.converter._dispatch('escapeSpecialCharsWithinTagAttributes.after', text, options, globals);
      return text;
    });

    /**
     * Handle github codeblocks prior to running HashHTML so that
     * HTML contained within the codeblock gets escaped properly
     * Example:
     * ```ruby
     *     def hello_world(x)
     *       puts "Hello, #{x}"
     *     end
     * ```
     */
    showdown.subParser('githubCodeBlocks', function (text, options, globals) {

      // early exit if option is not enabled
      if (!options.ghCodeBlocks) {
        return text;
      }

      text = globals.converter._dispatch('githubCodeBlocks.before', text, options, globals);

      text += '¨0';

      text = text.replace(/(?:^|\n)(```+|~~~+)([^\s`~]*)\n([\s\S]*?)\n\1/g, function (wholeMatch, delim, language, codeblock) {
        var end = (options.omitExtraWLInCodeBlocks) ? '' : '\n';

        // First parse the github code block
        codeblock = showdown.subParser('encodeCode')(codeblock, options, globals);
        codeblock = showdown.subParser('detab')(codeblock, options, globals);
        codeblock = codeblock.replace(/^\n+/g, ''); // trim leading newlines
        codeblock = codeblock.replace(/\n+$/g, ''); // trim trailing whitespace

        codeblock = '<pre><code' + (language ? ' class="' + language + ' language-' + language + '"' : '') + '>' + codeblock + end + '</code></pre>';

        codeblock = showdown.subParser('hashBlock')(codeblock, options, globals);

        // Since GHCodeblocks can be false positives, we need to
        // store the primitive text and the parsed text in a global var,
        // and then return a token
        return '\n\n¨G' + (globals.ghCodeBlocks.push({text: wholeMatch, codeblock: codeblock}) - 1) + 'G\n\n';
      });

      // attacklab: strip sentinel
      text = text.replace(/¨0/, '');

      return globals.converter._dispatch('githubCodeBlocks.after', text, options, globals);
    });

    showdown.subParser('hashBlock', function (text, options, globals) {
      text = globals.converter._dispatch('hashBlock.before', text, options, globals);
      text = text.replace(/(^\n+|\n+$)/g, '');
      text = '\n\n¨K' + (globals.gHtmlBlocks.push(text) - 1) + 'K\n\n';
      text = globals.converter._dispatch('hashBlock.after', text, options, globals);
      return text;
    });

    /**
     * Hash and escape <code> elements that should not be parsed as markdown
     */
    showdown.subParser('hashCodeTags', function (text, options, globals) {
      text = globals.converter._dispatch('hashCodeTags.before', text, options, globals);

      var repFunc = function (wholeMatch, match, left, right) {
        var codeblock = left + showdown.subParser('encodeCode')(match, options, globals) + right;
        return '¨C' + (globals.gHtmlSpans.push(codeblock) - 1) + 'C';
      };

      // Hash naked <code>
      text = showdown.helper.replaceRecursiveRegExp(text, repFunc, '<code\\b[^>]*>', '</code>', 'gim');

      text = globals.converter._dispatch('hashCodeTags.after', text, options, globals);
      return text;
    });

    showdown.subParser('hashElement', function (text, options, globals) {

      return function (wholeMatch, m1) {
        var blockText = m1;

        // Undo double lines
        blockText = blockText.replace(/\n\n/g, '\n');
        blockText = blockText.replace(/^\n/, '');

        // strip trailing blank lines
        blockText = blockText.replace(/\n+$/g, '');

        // Replace the element text with a marker ("¨KxK" where x is its key)
        blockText = '\n\n¨K' + (globals.gHtmlBlocks.push(blockText) - 1) + 'K\n\n';

        return blockText;
      };
    });

    showdown.subParser('hashHTMLBlocks', function (text, options, globals) {
      text = globals.converter._dispatch('hashHTMLBlocks.before', text, options, globals);

      var blockTags = [
            'pre',
            'div',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'blockquote',
            'table',
            'dl',
            'ol',
            'ul',
            'script',
            'noscript',
            'form',
            'fieldset',
            'iframe',
            'math',
            'style',
            'section',
            'header',
            'footer',
            'nav',
            'article',
            'aside',
            'address',
            'audio',
            'canvas',
            'figure',
            'hgroup',
            'output',
            'video',
            'p'
          ],
          repFunc = function (wholeMatch, match, left, right) {
            var txt = wholeMatch;
            // check if this html element is marked as markdown
            // if so, it's contents should be parsed as markdown
            if (left.search(/\bmarkdown\b/) !== -1) {
              txt = left + globals.converter.makeHtml(match) + right;
            }
            return '\n\n¨K' + (globals.gHtmlBlocks.push(txt) - 1) + 'K\n\n';
          };

      if (options.backslashEscapesHTMLTags) {
        // encode backslash escaped HTML tags
        text = text.replace(/\\<(\/?[^>]+?)>/g, function (wm, inside) {
          return '&lt;' + inside + '&gt;';
        });
      }

      // hash HTML Blocks
      for (var i = 0; i < blockTags.length; ++i) {

        var opTagPos,
            rgx1     = new RegExp('^ {0,3}(<' + blockTags[i] + '\\b[^>]*>)', 'im'),
            patLeft  = '<' + blockTags[i] + '\\b[^>]*>',
            patRight = '</' + blockTags[i] + '>';
        // 1. Look for the first position of the first opening HTML tag in the text
        while ((opTagPos = showdown.helper.regexIndexOf(text, rgx1)) !== -1) {

          // if the HTML tag is \ escaped, we need to escape it and break


          //2. Split the text in that position
          var subTexts = showdown.helper.splitAtIndex(text, opTagPos),
          //3. Match recursively
              newSubText1 = showdown.helper.replaceRecursiveRegExp(subTexts[1], repFunc, patLeft, patRight, 'im');

          // prevent an infinite loop
          if (newSubText1 === subTexts[1]) {
            break;
          }
          text = subTexts[0].concat(newSubText1);
        }
      }
      // HR SPECIAL CASE
      text = text.replace(/(\n {0,3}(<(hr)\b([^<>])*?\/?>)[ \t]*(?=\n{2,}))/g,
        showdown.subParser('hashElement')(text, options, globals));

      // Special case for standalone HTML comments
      text = showdown.helper.replaceRecursiveRegExp(text, function (txt) {
        return '\n\n¨K' + (globals.gHtmlBlocks.push(txt) - 1) + 'K\n\n';
      }, '^ {0,3}<!--', '-->', 'gm');

      // PHP and ASP-style processor instructions (<?...?> and <%...%>)
      text = text.replace(/(?:\n\n)( {0,3}(?:<([?%])[^\r]*?\2>)[ \t]*(?=\n{2,}))/g,
        showdown.subParser('hashElement')(text, options, globals));

      text = globals.converter._dispatch('hashHTMLBlocks.after', text, options, globals);
      return text;
    });

    /**
     * Hash span elements that should not be parsed as markdown
     */
    showdown.subParser('hashHTMLSpans', function (text, options, globals) {
      text = globals.converter._dispatch('hashHTMLSpans.before', text, options, globals);

      function hashHTMLSpan (html) {
        return '¨C' + (globals.gHtmlSpans.push(html) - 1) + 'C';
      }

      // Hash Self Closing tags
      text = text.replace(/<[^>]+?\/>/gi, function (wm) {
        return hashHTMLSpan(wm);
      });

      // Hash tags without properties
      text = text.replace(/<([^>]+?)>[\s\S]*?<\/\1>/g, function (wm) {
        return hashHTMLSpan(wm);
      });

      // Hash tags with properties
      text = text.replace(/<([^>]+?)\s[^>]+?>[\s\S]*?<\/\1>/g, function (wm) {
        return hashHTMLSpan(wm);
      });

      // Hash self closing tags without />
      text = text.replace(/<[^>]+?>/gi, function (wm) {
        return hashHTMLSpan(wm);
      });

      /*showdown.helper.matchRecursiveRegExp(text, '<code\\b[^>]*>', '</code>', 'gi');*/

      text = globals.converter._dispatch('hashHTMLSpans.after', text, options, globals);
      return text;
    });

    /**
     * Unhash HTML spans
     */
    showdown.subParser('unhashHTMLSpans', function (text, options, globals) {
      text = globals.converter._dispatch('unhashHTMLSpans.before', text, options, globals);

      for (var i = 0; i < globals.gHtmlSpans.length; ++i) {
        var repText = globals.gHtmlSpans[i],
            // limiter to prevent infinite loop (assume 10 as limit for recurse)
            limit = 0;

        while (/¨C(\d+)C/.test(repText)) {
          var num = RegExp.$1;
          repText = repText.replace('¨C' + num + 'C', globals.gHtmlSpans[num]);
          if (limit === 10) {
            console.error('maximum nesting of 10 spans reached!!!');
            break;
          }
          ++limit;
        }
        text = text.replace('¨C' + i + 'C', repText);
      }

      text = globals.converter._dispatch('unhashHTMLSpans.after', text, options, globals);
      return text;
    });

    /**
     * Hash and escape <pre><code> elements that should not be parsed as markdown
     */
    showdown.subParser('hashPreCodeTags', function (text, options, globals) {
      text = globals.converter._dispatch('hashPreCodeTags.before', text, options, globals);

      var repFunc = function (wholeMatch, match, left, right) {
        // encode html entities
        var codeblock = left + showdown.subParser('encodeCode')(match, options, globals) + right;
        return '\n\n¨G' + (globals.ghCodeBlocks.push({text: wholeMatch, codeblock: codeblock}) - 1) + 'G\n\n';
      };

      // Hash <pre><code>
      text = showdown.helper.replaceRecursiveRegExp(text, repFunc, '^ {0,3}<pre\\b[^>]*>\\s*<code\\b[^>]*>', '^ {0,3}</code>\\s*</pre>', 'gim');

      text = globals.converter._dispatch('hashPreCodeTags.after', text, options, globals);
      return text;
    });

    showdown.subParser('headers', function (text, options, globals) {

      text = globals.converter._dispatch('headers.before', text, options, globals);

      var headerLevelStart = (isNaN(parseInt(options.headerLevelStart))) ? 1 : parseInt(options.headerLevelStart),

      // Set text-style headers:
      //	Header 1
      //	========
      //
      //	Header 2
      //	--------
      //
          setextRegexH1 = (options.smoothLivePreview) ? /^(.+)[ \t]*\n={2,}[ \t]*\n+/gm : /^(.+)[ \t]*\n=+[ \t]*\n+/gm,
          setextRegexH2 = (options.smoothLivePreview) ? /^(.+)[ \t]*\n-{2,}[ \t]*\n+/gm : /^(.+)[ \t]*\n-+[ \t]*\n+/gm;

      text = text.replace(setextRegexH1, function (wholeMatch, m1) {

        var spanGamut = showdown.subParser('spanGamut')(m1, options, globals),
            hID = (options.noHeaderId) ? '' : ' id="' + headerId(m1) + '"',
            hLevel = headerLevelStart,
            hashBlock = '<h' + hLevel + hID + '>' + spanGamut + '</h' + hLevel + '>';
        return showdown.subParser('hashBlock')(hashBlock, options, globals);
      });

      text = text.replace(setextRegexH2, function (matchFound, m1) {
        var spanGamut = showdown.subParser('spanGamut')(m1, options, globals),
            hID = (options.noHeaderId) ? '' : ' id="' + headerId(m1) + '"',
            hLevel = headerLevelStart + 1,
            hashBlock = '<h' + hLevel + hID + '>' + spanGamut + '</h' + hLevel + '>';
        return showdown.subParser('hashBlock')(hashBlock, options, globals);
      });

      // atx-style headers:
      //  # Header 1
      //  ## Header 2
      //  ## Header 2 with closing hashes ##
      //  ...
      //  ###### Header 6
      //
      var atxStyle = (options.requireSpaceBeforeHeadingText) ? /^(#{1,6})[ \t]+(.+?)[ \t]*#*\n+/gm : /^(#{1,6})[ \t]*(.+?)[ \t]*#*\n+/gm;

      text = text.replace(atxStyle, function (wholeMatch, m1, m2) {
        var hText = m2;
        if (options.customizedHeaderId) {
          hText = m2.replace(/\s?\{([^{]+?)}\s*$/, '');
        }

        var span = showdown.subParser('spanGamut')(hText, options, globals),
            hID = (options.noHeaderId) ? '' : ' id="' + headerId(m2) + '"',
            hLevel = headerLevelStart - 1 + m1.length,
            header = '<h' + hLevel + hID + '>' + span + '</h' + hLevel + '>';

        return showdown.subParser('hashBlock')(header, options, globals);
      });

      function headerId (m) {
        var title,
            prefix;

        // It is separate from other options to allow combining prefix and customized
        if (options.customizedHeaderId) {
          var match = m.match(/\{([^{]+?)}\s*$/);
          if (match && match[1]) {
            m = match[1];
          }
        }

        title = m;

        // Prefix id to prevent causing inadvertent pre-existing style matches.
        if (showdown.helper.isString(options.prefixHeaderId)) {
          prefix = options.prefixHeaderId;
        } else if (options.prefixHeaderId === true) {
          prefix = 'section-';
        } else {
          prefix = '';
        }

        if (!options.rawPrefixHeaderId) {
          title = prefix + title;
        }

        if (options.ghCompatibleHeaderId) {
          title = title
            .replace(/ /g, '-')
            // replace previously escaped chars (&, ¨ and $)
            .replace(/&amp;/g, '')
            .replace(/¨T/g, '')
            .replace(/¨D/g, '')
            // replace rest of the chars (&~$ are repeated as they might have been escaped)
            // borrowed from github's redcarpet (some they should produce similar results)
            .replace(/[&+$,\/:;=?@"#{}|^¨~\[\]`\\*)(%.!'<>]/g, '')
            .toLowerCase();
        } else if (options.rawHeaderId) {
          title = title
            .replace(/ /g, '-')
            // replace previously escaped chars (&, ¨ and $)
            .replace(/&amp;/g, '&')
            .replace(/¨T/g, '¨')
            .replace(/¨D/g, '$')
            // replace " and '
            .replace(/["']/g, '-')
            .toLowerCase();
        } else {
          title = title
            .replace(/[^\w]/g, '')
            .toLowerCase();
        }

        if (options.rawPrefixHeaderId) {
          title = prefix + title;
        }

        if (globals.hashLinkCounts[title]) {
          title = title + '-' + (globals.hashLinkCounts[title]++);
        } else {
          globals.hashLinkCounts[title] = 1;
        }
        return title;
      }

      text = globals.converter._dispatch('headers.after', text, options, globals);
      return text;
    });

    /**
     * Turn Markdown link shortcuts into XHTML <a> tags.
     */
    showdown.subParser('horizontalRule', function (text, options, globals) {
      text = globals.converter._dispatch('horizontalRule.before', text, options, globals);

      var key = showdown.subParser('hashBlock')('<hr />', options, globals);
      text = text.replace(/^ {0,2}( ?-){3,}[ \t]*$/gm, key);
      text = text.replace(/^ {0,2}( ?\*){3,}[ \t]*$/gm, key);
      text = text.replace(/^ {0,2}( ?_){3,}[ \t]*$/gm, key);

      text = globals.converter._dispatch('horizontalRule.after', text, options, globals);
      return text;
    });

    /**
     * Turn Markdown image shortcuts into <img> tags.
     */
    showdown.subParser('images', function (text, options, globals) {

      text = globals.converter._dispatch('images.before', text, options, globals);

      var inlineRegExp      = /!\[([^\]]*?)][ \t]*()\([ \t]?<?([\S]+?(?:\([\S]*?\)[\S]*?)?)>?(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*(?:(["'])([^"]*?)\6)?[ \t]?\)/g,
          crazyRegExp       = /!\[([^\]]*?)][ \t]*()\([ \t]?<([^>]*)>(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*(?:(?:(["'])([^"]*?)\6))?[ \t]?\)/g,
          base64RegExp      = /!\[([^\]]*?)][ \t]*()\([ \t]?<?(data:.+?\/.+?;base64,[A-Za-z0-9+/=\n]+?)>?(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*(?:(["'])([^"]*?)\6)?[ \t]?\)/g,
          referenceRegExp   = /!\[([^\]]*?)] ?(?:\n *)?\[([\s\S]*?)]()()()()()/g,
          refShortcutRegExp = /!\[([^\[\]]+)]()()()()()/g;

      function writeImageTagBase64 (wholeMatch, altText, linkId, url, width, height, m5, title) {
        url = url.replace(/\s/g, '');
        return writeImageTag (wholeMatch, altText, linkId, url, width, height, m5, title);
      }

      function writeImageTag (wholeMatch, altText, linkId, url, width, height, m5, title) {

        var gUrls   = globals.gUrls,
            gTitles = globals.gTitles,
            gDims   = globals.gDimensions;

        linkId = linkId.toLowerCase();

        if (!title) {
          title = '';
        }
        // Special case for explicit empty url
        if (wholeMatch.search(/\(<?\s*>? ?(['"].*['"])?\)$/m) > -1) {
          url = '';

        } else if (url === '' || url === null) {
          if (linkId === '' || linkId === null) {
            // lower-case and turn embedded newlines into spaces
            linkId = altText.toLowerCase().replace(/ ?\n/g, ' ');
          }
          url = '#' + linkId;

          if (!showdown.helper.isUndefined(gUrls[linkId])) {
            url = gUrls[linkId];
            if (!showdown.helper.isUndefined(gTitles[linkId])) {
              title = gTitles[linkId];
            }
            if (!showdown.helper.isUndefined(gDims[linkId])) {
              width = gDims[linkId].width;
              height = gDims[linkId].height;
            }
          } else {
            return wholeMatch;
          }
        }

        altText = altText
          .replace(/"/g, '&quot;')
        //altText = showdown.helper.escapeCharacters(altText, '*_', false);
          .replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
        //url = showdown.helper.escapeCharacters(url, '*_', false);
        url = url.replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
        var result = '<img src="' + url + '" alt="' + altText + '"';

        if (title) {
          title = title
            .replace(/"/g, '&quot;')
          //title = showdown.helper.escapeCharacters(title, '*_', false);
            .replace(showdown.helper.regexes.asteriskDashAndColon, showdown.helper.escapeCharactersCallback);
          result += ' title="' + title + '"';
        }

        if (width && height) {
          width  = (width === '*') ? 'auto' : width;
          height = (height === '*') ? 'auto' : height;

          result += ' width="' + width + '"';
          result += ' height="' + height + '"';
        }

        result += ' />';

        return result;
      }

      // First, handle reference-style labeled images: ![alt text][id]
      text = text.replace(referenceRegExp, writeImageTag);

      // Next, handle inline images:  ![alt text](url =<width>x<height> "optional title")

      // base64 encoded images
      text = text.replace(base64RegExp, writeImageTagBase64);

      // cases with crazy urls like ./image/cat1).png
      text = text.replace(crazyRegExp, writeImageTag);

      // normal cases
      text = text.replace(inlineRegExp, writeImageTag);

      // handle reference-style shortcuts: ![img text]
      text = text.replace(refShortcutRegExp, writeImageTag);

      text = globals.converter._dispatch('images.after', text, options, globals);
      return text;
    });

    showdown.subParser('italicsAndBold', function (text, options, globals) {

      text = globals.converter._dispatch('italicsAndBold.before', text, options, globals);

      // it's faster to have 3 separate regexes for each case than have just one
      // because of backtracing, in some cases, it could lead to an exponential effect
      // called "catastrophic backtrace". Ominous!

      function parseInside (txt, left, right) {
        /*
        if (options.simplifiedAutoLink) {
          txt = showdown.subParser('simplifiedAutoLinks')(txt, options, globals);
        }
        */
        return left + txt + right;
      }

      // Parse underscores
      if (options.literalMidWordUnderscores) {
        text = text.replace(/\b___(\S[\s\S]*)___\b/g, function (wm, txt) {
          return parseInside (txt, '<strong><em>', '</em></strong>');
        });
        text = text.replace(/\b__(\S[\s\S]*)__\b/g, function (wm, txt) {
          return parseInside (txt, '<strong>', '</strong>');
        });
        text = text.replace(/\b_(\S[\s\S]*?)_\b/g, function (wm, txt) {
          return parseInside (txt, '<em>', '</em>');
        });
      } else {
        text = text.replace(/___(\S[\s\S]*?)___/g, function (wm, m) {
          return (/\S$/.test(m)) ? parseInside (m, '<strong><em>', '</em></strong>') : wm;
        });
        text = text.replace(/__(\S[\s\S]*?)__/g, function (wm, m) {
          return (/\S$/.test(m)) ? parseInside (m, '<strong>', '</strong>') : wm;
        });
        text = text.replace(/_([^\s_][\s\S]*?)_/g, function (wm, m) {
          // !/^_[^_]/.test(m) - test if it doesn't start with __ (since it seems redundant, we removed it)
          return (/\S$/.test(m)) ? parseInside (m, '<em>', '</em>') : wm;
        });
      }

      // Now parse asterisks
      if (options.literalMidWordAsterisks) {
        text = text.replace(/([^*]|^)\B\*\*\*(\S[\s\S]+?)\*\*\*\B(?!\*)/g, function (wm, lead, txt) {
          return parseInside (txt, lead + '<strong><em>', '</em></strong>');
        });
        text = text.replace(/([^*]|^)\B\*\*(\S[\s\S]+?)\*\*\B(?!\*)/g, function (wm, lead, txt) {
          return parseInside (txt, lead + '<strong>', '</strong>');
        });
        text = text.replace(/([^*]|^)\B\*(\S[\s\S]+?)\*\B(?!\*)/g, function (wm, lead, txt) {
          return parseInside (txt, lead + '<em>', '</em>');
        });
      } else {
        text = text.replace(/\*\*\*(\S[\s\S]*?)\*\*\*/g, function (wm, m) {
          return (/\S$/.test(m)) ? parseInside (m, '<strong><em>', '</em></strong>') : wm;
        });
        text = text.replace(/\*\*(\S[\s\S]*?)\*\*/g, function (wm, m) {
          return (/\S$/.test(m)) ? parseInside (m, '<strong>', '</strong>') : wm;
        });
        text = text.replace(/\*([^\s*][\s\S]*?)\*/g, function (wm, m) {
          // !/^\*[^*]/.test(m) - test if it doesn't start with ** (since it seems redundant, we removed it)
          return (/\S$/.test(m)) ? parseInside (m, '<em>', '</em>') : wm;
        });
      }


      text = globals.converter._dispatch('italicsAndBold.after', text, options, globals);
      return text;
    });

    /**
     * Form HTML ordered (numbered) and unordered (bulleted) lists.
     */
    showdown.subParser('lists', function (text, options, globals) {

      /**
       * Process the contents of a single ordered or unordered list, splitting it
       * into individual list items.
       * @param {string} listStr
       * @param {boolean} trimTrailing
       * @returns {string}
       */
      function processListItems (listStr, trimTrailing) {
        // The $g_list_level global keeps track of when we're inside a list.
        // Each time we enter a list, we increment it; when we leave a list,
        // we decrement. If it's zero, we're not in a list anymore.
        //
        // We do this because when we're not inside a list, we want to treat
        // something like this:
        //
        //    I recommend upgrading to version
        //    8. Oops, now this line is treated
        //    as a sub-list.
        //
        // As a single paragraph, despite the fact that the second line starts
        // with a digit-period-space sequence.
        //
        // Whereas when we're inside a list (or sub-list), that line will be
        // treated as the start of a sub-list. What a kludge, huh? This is
        // an aspect of Markdown's syntax that's hard to parse perfectly
        // without resorting to mind-reading. Perhaps the solution is to
        // change the syntax rules such that sub-lists must start with a
        // starting cardinal number; e.g. "1." or "a.".
        globals.gListLevel++;

        // trim trailing blank lines:
        listStr = listStr.replace(/\n{2,}$/, '\n');

        // attacklab: add sentinel to emulate \z
        listStr += '¨0';

        var rgx = /(\n)?(^ {0,3})([*+-]|\d+[.])[ \t]+((\[(x|X| )?])?[ \t]*[^\r]+?(\n{1,2}))(?=\n*(¨0| {0,3}([*+-]|\d+[.])[ \t]+))/gm,
            isParagraphed = (/\n[ \t]*\n(?!¨0)/.test(listStr));

        // Since version 1.5, nesting sublists requires 4 spaces (or 1 tab) indentation,
        // which is a syntax breaking change
        // activating this option reverts to old behavior
        if (options.disableForced4SpacesIndentedSublists) {
          rgx = /(\n)?(^ {0,3})([*+-]|\d+[.])[ \t]+((\[(x|X| )?])?[ \t]*[^\r]+?(\n{1,2}))(?=\n*(¨0|\2([*+-]|\d+[.])[ \t]+))/gm;
        }

        listStr = listStr.replace(rgx, function (wholeMatch, m1, m2, m3, m4, taskbtn, checked) {
          checked = (checked && checked.trim() !== '');

          var item = showdown.subParser('outdent')(m4, options, globals),
              bulletStyle = '';

          // Support for github tasklists
          if (taskbtn && options.tasklists) {
            bulletStyle = ' class="task-list-item" style="list-style-type: none;"';
            item = item.replace(/^[ \t]*\[(x|X| )?]/m, function () {
              var otp = '<input type="checkbox" disabled style="margin: 0px 0.35em 0.25em -1.6em; vertical-align: middle;"';
              if (checked) {
                otp += ' checked';
              }
              otp += '>';
              return otp;
            });
          }

          // ISSUE #312
          // This input: - - - a
          // causes trouble to the parser, since it interprets it as:
          // <ul><li><li><li>a</li></li></li></ul>
          // instead of:
          // <ul><li>- - a</li></ul>
          // So, to prevent it, we will put a marker (¨A)in the beginning of the line
          // Kind of hackish/monkey patching, but seems more effective than overcomplicating the list parser
          item = item.replace(/^([-*+]|\d\.)[ \t]+[\S\n ]*/g, function (wm2) {
            return '¨A' + wm2;
          });

          // m1 - Leading line or
          // Has a double return (multi paragraph) or
          // Has sublist
          if (m1 || (item.search(/\n{2,}/) > -1)) {
            item = showdown.subParser('githubCodeBlocks')(item, options, globals);
            item = showdown.subParser('blockGamut')(item, options, globals);
          } else {
            // Recursion for sub-lists:
            item = showdown.subParser('lists')(item, options, globals);
            item = item.replace(/\n$/, ''); // chomp(item)
            item = showdown.subParser('hashHTMLBlocks')(item, options, globals);

            // Colapse double linebreaks
            item = item.replace(/\n\n+/g, '\n\n');
            if (isParagraphed) {
              item = showdown.subParser('paragraphs')(item, options, globals);
            } else {
              item = showdown.subParser('spanGamut')(item, options, globals);
            }
          }

          // now we need to remove the marker (¨A)
          item = item.replace('¨A', '');
          // we can finally wrap the line in list item tags
          item =  '<li' + bulletStyle + '>' + item + '</li>\n';

          return item;
        });

        // attacklab: strip sentinel
        listStr = listStr.replace(/¨0/g, '');

        globals.gListLevel--;

        if (trimTrailing) {
          listStr = listStr.replace(/\s+$/, '');
        }

        return listStr;
      }

      function styleStartNumber (list, listType) {
        // check if ol and starts by a number different than 1
        if (listType === 'ol') {
          var res = list.match(/^ *(\d+)\./);
          if (res && res[1] !== '1') {
            return ' start="' + res[1] + '"';
          }
        }
        return '';
      }

      /**
       * Check and parse consecutive lists (better fix for issue #142)
       * @param {string} list
       * @param {string} listType
       * @param {boolean} trimTrailing
       * @returns {string}
       */
      function parseConsecutiveLists (list, listType, trimTrailing) {
        // check if we caught 2 or more consecutive lists by mistake
        // we use the counterRgx, meaning if listType is UL we look for OL and vice versa
        var olRgx = (options.disableForced4SpacesIndentedSublists) ? /^ ?\d+\.[ \t]/gm : /^ {0,3}\d+\.[ \t]/gm,
            ulRgx = (options.disableForced4SpacesIndentedSublists) ? /^ ?[*+-][ \t]/gm : /^ {0,3}[*+-][ \t]/gm,
            counterRxg = (listType === 'ul') ? olRgx : ulRgx,
            result = '';

        if (list.search(counterRxg) !== -1) {
          (function parseCL (txt) {
            var pos = txt.search(counterRxg),
                style = styleStartNumber(list, listType);
            if (pos !== -1) {
              // slice
              result += '\n\n<' + listType + style + '>\n' + processListItems(txt.slice(0, pos), !!trimTrailing) + '</' + listType + '>\n';

              // invert counterType and listType
              listType = (listType === 'ul') ? 'ol' : 'ul';
              counterRxg = (listType === 'ul') ? olRgx : ulRgx;

              //recurse
              parseCL(txt.slice(pos));
            } else {
              result += '\n\n<' + listType + style + '>\n' + processListItems(txt, !!trimTrailing) + '</' + listType + '>\n';
            }
          })(list);
        } else {
          var style = styleStartNumber(list, listType);
          result = '\n\n<' + listType + style + '>\n' + processListItems(list, !!trimTrailing) + '</' + listType + '>\n';
        }

        return result;
      }

      /** Start of list parsing **/
      text = globals.converter._dispatch('lists.before', text, options, globals);
      // add sentinel to hack around khtml/safari bug:
      // http://bugs.webkit.org/show_bug.cgi?id=11231
      text += '¨0';

      if (globals.gListLevel) {
        text = text.replace(/^(( {0,3}([*+-]|\d+[.])[ \t]+)[^\r]+?(¨0|\n{2,}(?=\S)(?![ \t]*(?:[*+-]|\d+[.])[ \t]+)))/gm,
          function (wholeMatch, list, m2) {
            var listType = (m2.search(/[*+-]/g) > -1) ? 'ul' : 'ol';
            return parseConsecutiveLists(list, listType, true);
          }
        );
      } else {
        text = text.replace(/(\n\n|^\n?)(( {0,3}([*+-]|\d+[.])[ \t]+)[^\r]+?(¨0|\n{2,}(?=\S)(?![ \t]*(?:[*+-]|\d+[.])[ \t]+)))/gm,
          function (wholeMatch, m1, list, m3) {
            var listType = (m3.search(/[*+-]/g) > -1) ? 'ul' : 'ol';
            return parseConsecutiveLists(list, listType, false);
          }
        );
      }

      // strip sentinel
      text = text.replace(/¨0/, '');
      text = globals.converter._dispatch('lists.after', text, options, globals);
      return text;
    });

    /**
     * Parse metadata at the top of the document
     */
    showdown.subParser('metadata', function (text, options, globals) {

      if (!options.metadata) {
        return text;
      }

      text = globals.converter._dispatch('metadata.before', text, options, globals);

      function parseMetadataContents (content) {
        // raw is raw so it's not changed in any way
        globals.metadata.raw = content;

        // escape chars forbidden in html attributes
        // double quotes
        content = content
          // ampersand first
          .replace(/&/g, '&amp;')
          // double quotes
          .replace(/"/g, '&quot;');

        content = content.replace(/\n {4}/g, ' ');
        content.replace(/^([\S ]+): +([\s\S]+?)$/gm, function (wm, key, value) {
          globals.metadata.parsed[key] = value;
          return '';
        });
      }

      text = text.replace(/^\s*«««+(\S*?)\n([\s\S]+?)\n»»»+\n/, function (wholematch, format, content) {
        parseMetadataContents(content);
        return '¨M';
      });

      text = text.replace(/^\s*---+(\S*?)\n([\s\S]+?)\n---+\n/, function (wholematch, format, content) {
        if (format) {
          globals.metadata.format = format;
        }
        parseMetadataContents(content);
        return '¨M';
      });

      text = text.replace(/¨M/g, '');

      text = globals.converter._dispatch('metadata.after', text, options, globals);
      return text;
    });

    /**
     * Remove one level of line-leading tabs or spaces
     */
    showdown.subParser('outdent', function (text, options, globals) {
      text = globals.converter._dispatch('outdent.before', text, options, globals);

      // attacklab: hack around Konqueror 3.5.4 bug:
      // "----------bug".replace(/^-/g,"") == "bug"
      text = text.replace(/^(\t|[ ]{1,4})/gm, '¨0'); // attacklab: g_tab_width

      // attacklab: clean up hack
      text = text.replace(/¨0/g, '');

      text = globals.converter._dispatch('outdent.after', text, options, globals);
      return text;
    });

    /**
     *
     */
    showdown.subParser('paragraphs', function (text, options, globals) {

      text = globals.converter._dispatch('paragraphs.before', text, options, globals);
      // Strip leading and trailing lines:
      text = text.replace(/^\n+/g, '');
      text = text.replace(/\n+$/g, '');

      var grafs = text.split(/\n{2,}/g),
          grafsOut = [],
          end = grafs.length; // Wrap <p> tags

      for (var i = 0; i < end; i++) {
        var str = grafs[i];
        // if this is an HTML marker, copy it
        if (str.search(/¨(K|G)(\d+)\1/g) >= 0) {
          grafsOut.push(str);

        // test for presence of characters to prevent empty lines being parsed
        // as paragraphs (resulting in undesired extra empty paragraphs)
        } else if (str.search(/\S/) >= 0) {
          str = showdown.subParser('spanGamut')(str, options, globals);
          str = str.replace(/^([ \t]*)/g, '<p>');
          str += '</p>';
          grafsOut.push(str);
        }
      }

      /** Unhashify HTML blocks */
      end = grafsOut.length;
      for (i = 0; i < end; i++) {
        var blockText = '',
            grafsOutIt = grafsOut[i],
            codeFlag = false;
        // if this is a marker for an html block...
        // use RegExp.test instead of string.search because of QML bug
        while (/¨(K|G)(\d+)\1/.test(grafsOutIt)) {
          var delim = RegExp.$1,
              num   = RegExp.$2;

          if (delim === 'K') {
            blockText = globals.gHtmlBlocks[num];
          } else {
            // we need to check if ghBlock is a false positive
            if (codeFlag) {
              // use encoded version of all text
              blockText = showdown.subParser('encodeCode')(globals.ghCodeBlocks[num].text, options, globals);
            } else {
              blockText = globals.ghCodeBlocks[num].codeblock;
            }
          }
          blockText = blockText.replace(/\$/g, '$$$$'); // Escape any dollar signs

          grafsOutIt = grafsOutIt.replace(/(\n\n)?¨(K|G)\d+\2(\n\n)?/, blockText);
          // Check if grafsOutIt is a pre->code
          if (/^<pre\b[^>]*>\s*<code\b[^>]*>/.test(grafsOutIt)) {
            codeFlag = true;
          }
        }
        grafsOut[i] = grafsOutIt;
      }
      text = grafsOut.join('\n');
      // Strip leading and trailing lines:
      text = text.replace(/^\n+/g, '');
      text = text.replace(/\n+$/g, '');
      return globals.converter._dispatch('paragraphs.after', text, options, globals);
    });

    /**
     * Run extension
     */
    showdown.subParser('runExtension', function (ext, text, options, globals) {

      if (ext.filter) {
        text = ext.filter(text, globals.converter, options);

      } else if (ext.regex) {
        // TODO remove this when old extension loading mechanism is deprecated
        var re = ext.regex;
        if (!(re instanceof RegExp)) {
          re = new RegExp(re, 'g');
        }
        text = text.replace(re, ext.replace);
      }

      return text;
    });

    /**
     * These are all the transformations that occur *within* block-level
     * tags like paragraphs, headers, and list items.
     */
    showdown.subParser('spanGamut', function (text, options, globals) {

      text = globals.converter._dispatch('spanGamut.before', text, options, globals);
      text = showdown.subParser('codeSpans')(text, options, globals);
      text = showdown.subParser('escapeSpecialCharsWithinTagAttributes')(text, options, globals);
      text = showdown.subParser('encodeBackslashEscapes')(text, options, globals);

      // Process anchor and image tags. Images must come first,
      // because ![foo][f] looks like an anchor.
      text = showdown.subParser('images')(text, options, globals);
      text = showdown.subParser('anchors')(text, options, globals);

      // Make links out of things like `<http://example.com/>`
      // Must come after anchors, because you can use < and >
      // delimiters in inline links like [this](<url>).
      text = showdown.subParser('autoLinks')(text, options, globals);
      text = showdown.subParser('simplifiedAutoLinks')(text, options, globals);
      text = showdown.subParser('emoji')(text, options, globals);
      text = showdown.subParser('underline')(text, options, globals);
      text = showdown.subParser('italicsAndBold')(text, options, globals);
      text = showdown.subParser('strikethrough')(text, options, globals);
      text = showdown.subParser('ellipsis')(text, options, globals);

      // we need to hash HTML tags inside spans
      text = showdown.subParser('hashHTMLSpans')(text, options, globals);

      // now we encode amps and angles
      text = showdown.subParser('encodeAmpsAndAngles')(text, options, globals);

      // Do hard breaks
      if (options.simpleLineBreaks) {
        // GFM style hard breaks
        // only add line breaks if the text does not contain a block (special case for lists)
        if (!/\n\n¨K/.test(text)) {
          text = text.replace(/\n+/g, '<br />\n');
        }
      } else {
        // Vanilla hard breaks
        text = text.replace(/  +\n/g, '<br />\n');
      }

      text = globals.converter._dispatch('spanGamut.after', text, options, globals);
      return text;
    });

    showdown.subParser('strikethrough', function (text, options, globals) {

      function parseInside (txt) {
        if (options.simplifiedAutoLink) {
          txt = showdown.subParser('simplifiedAutoLinks')(txt, options, globals);
        }
        return '<del>' + txt + '</del>';
      }

      if (options.strikethrough) {
        text = globals.converter._dispatch('strikethrough.before', text, options, globals);
        text = text.replace(/(?:~){2}([\s\S]+?)(?:~){2}/g, function (wm, txt) { return parseInside(txt); });
        text = globals.converter._dispatch('strikethrough.after', text, options, globals);
      }

      return text;
    });

    /**
     * Strips link definitions from text, stores the URLs and titles in
     * hash references.
     * Link defs are in the form: ^[id]: url "optional title"
     */
    showdown.subParser('stripLinkDefinitions', function (text, options, globals) {

      var regex       = /^ {0,3}\[(.+)]:[ \t]*\n?[ \t]*<?([^>\s]+)>?(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*\n?[ \t]*(?:(\n*)["|'(](.+?)["|')][ \t]*)?(?:\n+|(?=¨0))/gm,
          base64Regex = /^ {0,3}\[(.+)]:[ \t]*\n?[ \t]*<?(data:.+?\/.+?;base64,[A-Za-z0-9+/=\n]+?)>?(?: =([*\d]+[A-Za-z%]{0,4})x([*\d]+[A-Za-z%]{0,4}))?[ \t]*\n?[ \t]*(?:(\n*)["|'(](.+?)["|')][ \t]*)?(?:\n\n|(?=¨0)|(?=\n\[))/gm;

      // attacklab: sentinel workarounds for lack of \A and \Z, safari\khtml bug
      text += '¨0';

      var replaceFunc = function (wholeMatch, linkId, url, width, height, blankLines, title) {
        linkId = linkId.toLowerCase();
        if (url.match(/^data:.+?\/.+?;base64,/)) {
          // remove newlines
          globals.gUrls[linkId] = url.replace(/\s/g, '');
        } else {
          globals.gUrls[linkId] = showdown.subParser('encodeAmpsAndAngles')(url, options, globals);  // Link IDs are case-insensitive
        }

        if (blankLines) {
          // Oops, found blank lines, so it's not a title.
          // Put back the parenthetical statement we stole.
          return blankLines + title;

        } else {
          if (title) {
            globals.gTitles[linkId] = title.replace(/"|'/g, '&quot;');
          }
          if (options.parseImgDimensions && width && height) {
            globals.gDimensions[linkId] = {
              width:  width,
              height: height
            };
          }
        }
        // Completely remove the definition from the text
        return '';
      };

      // first we try to find base64 link references
      text = text.replace(base64Regex, replaceFunc);

      text = text.replace(regex, replaceFunc);

      // attacklab: strip sentinel
      text = text.replace(/¨0/, '');

      return text;
    });

    showdown.subParser('tables', function (text, options, globals) {

      if (!options.tables) {
        return text;
      }

      var tableRgx       = /^ {0,3}\|?.+\|.+\n {0,3}\|?[ \t]*:?[ \t]*(?:[-=]){2,}[ \t]*:?[ \t]*\|[ \t]*:?[ \t]*(?:[-=]){2,}[\s\S]+?(?:\n\n|¨0)/gm,
        //singeColTblRgx = /^ {0,3}\|.+\|\n {0,3}\|[ \t]*:?[ \t]*(?:[-=]){2,}[ \t]*:?[ \t]*\|[ \t]*\n(?: {0,3}\|.+\|\n)+(?:\n\n|¨0)/gm;
          singeColTblRgx = /^ {0,3}\|.+\|[ \t]*\n {0,3}\|[ \t]*:?[ \t]*(?:[-=]){2,}[ \t]*:?[ \t]*\|[ \t]*\n( {0,3}\|.+\|[ \t]*\n)*(?:\n|¨0)/gm;

      function parseStyles (sLine) {
        if (/^:[ \t]*--*$/.test(sLine)) {
          return ' style="text-align:left;"';
        } else if (/^--*[ \t]*:[ \t]*$/.test(sLine)) {
          return ' style="text-align:right;"';
        } else if (/^:[ \t]*--*[ \t]*:$/.test(sLine)) {
          return ' style="text-align:center;"';
        } else {
          return '';
        }
      }

      function parseHeaders (header, style) {
        var id = '';
        header = header.trim();
        // support both tablesHeaderId and tableHeaderId due to error in documentation so we don't break backwards compatibility
        if (options.tablesHeaderId || options.tableHeaderId) {
          id = ' id="' + header.replace(/ /g, '_').toLowerCase() + '"';
        }
        header = showdown.subParser('spanGamut')(header, options, globals);

        return '<th' + id + style + '>' + header + '</th>\n';
      }

      function parseCells (cell, style) {
        var subText = showdown.subParser('spanGamut')(cell, options, globals);
        return '<td' + style + '>' + subText + '</td>\n';
      }

      function buildTable (headers, cells) {
        var tb = '<table>\n<thead>\n<tr>\n',
            tblLgn = headers.length;

        for (var i = 0; i < tblLgn; ++i) {
          tb += headers[i];
        }
        tb += '</tr>\n</thead>\n<tbody>\n';

        for (i = 0; i < cells.length; ++i) {
          tb += '<tr>\n';
          for (var ii = 0; ii < tblLgn; ++ii) {
            tb += cells[i][ii];
          }
          tb += '</tr>\n';
        }
        tb += '</tbody>\n</table>\n';
        return tb;
      }

      function parseTable (rawTable) {
        var i, tableLines = rawTable.split('\n');

        for (i = 0; i < tableLines.length; ++i) {
          // strip wrong first and last column if wrapped tables are used
          if (/^ {0,3}\|/.test(tableLines[i])) {
            tableLines[i] = tableLines[i].replace(/^ {0,3}\|/, '');
          }
          if (/\|[ \t]*$/.test(tableLines[i])) {
            tableLines[i] = tableLines[i].replace(/\|[ \t]*$/, '');
          }
          // parse code spans first, but we only support one line code spans
          tableLines[i] = showdown.subParser('codeSpans')(tableLines[i], options, globals);
        }

        var rawHeaders = tableLines[0].split('|').map(function (s) { return s.trim();}),
            rawStyles = tableLines[1].split('|').map(function (s) { return s.trim();}),
            rawCells = [],
            headers = [],
            styles = [],
            cells = [];

        tableLines.shift();
        tableLines.shift();

        for (i = 0; i < tableLines.length; ++i) {
          if (tableLines[i].trim() === '') {
            continue;
          }
          rawCells.push(
            tableLines[i]
              .split('|')
              .map(function (s) {
                return s.trim();
              })
          );
        }

        if (rawHeaders.length < rawStyles.length) {
          return rawTable;
        }

        for (i = 0; i < rawStyles.length; ++i) {
          styles.push(parseStyles(rawStyles[i]));
        }

        for (i = 0; i < rawHeaders.length; ++i) {
          if (showdown.helper.isUndefined(styles[i])) {
            styles[i] = '';
          }
          headers.push(parseHeaders(rawHeaders[i], styles[i]));
        }

        for (i = 0; i < rawCells.length; ++i) {
          var row = [];
          for (var ii = 0; ii < headers.length; ++ii) {
            if (showdown.helper.isUndefined(rawCells[i][ii])) ;
            row.push(parseCells(rawCells[i][ii], styles[ii]));
          }
          cells.push(row);
        }

        return buildTable(headers, cells);
      }

      text = globals.converter._dispatch('tables.before', text, options, globals);

      // find escaped pipe characters
      text = text.replace(/\\(\|)/g, showdown.helper.escapeCharactersCallback);

      // parse multi column tables
      text = text.replace(tableRgx, parseTable);

      // parse one column tables
      text = text.replace(singeColTblRgx, parseTable);

      text = globals.converter._dispatch('tables.after', text, options, globals);

      return text;
    });

    showdown.subParser('underline', function (text, options, globals) {

      if (!options.underline) {
        return text;
      }

      text = globals.converter._dispatch('underline.before', text, options, globals);

      if (options.literalMidWordUnderscores) {
        text = text.replace(/\b_?__(\S[\s\S]*)___?\b/g, function (wm, txt) {
          return '<u>' + txt + '</u>';
        });
      } else {
        text = text.replace(/_?__(\S[\s\S]*?)___?/g, function (wm, m) {
          return (/\S$/.test(m)) ? '<u>' + m + '</u>' : wm;
        });
      }

      // escape remaining underscores to prevent them being parsed by italic and bold
      text = text.replace(/(_)/g, showdown.helper.escapeCharactersCallback);

      text = globals.converter._dispatch('underline.after', text, options, globals);

      return text;
    });

    /**
     * Swap back in all the special characters we've hidden.
     */
    showdown.subParser('unescapeSpecialChars', function (text, options, globals) {
      text = globals.converter._dispatch('unescapeSpecialChars.before', text, options, globals);

      text = text.replace(/¨E(\d+)E/g, function (wholeMatch, m1) {
        var charCodeToReplace = parseInt(m1);
        return String.fromCharCode(charCodeToReplace);
      });

      text = globals.converter._dispatch('unescapeSpecialChars.after', text, options, globals);
      return text;
    });

    var root = this;

    // AMD Loader
    if (typeof undefined === 'function' && undefined.amd) {
      undefined(function () {
        return showdown;
      });

    // CommonJS/nodeJS Loader
    } else if (module.exports) {
      module.exports = showdown;

    // Regular Browser loader
    } else {
      root.showdown = showdown;
    }
    }).call(commonjsGlobal);

    //# sourceMappingURL=showdown.js.map
    });

    var moment = createCommonjsModule(function (module, exports) {
    (function (global, factory) {
        module.exports = factory();
    }(commonjsGlobal, (function () {
        var hookCallback;

        function hooks () {
            return hookCallback.apply(null, arguments);
        }

        // This is done to register the method called with moment()
        // without creating circular dependencies.
        function setHookCallback (callback) {
            hookCallback = callback;
        }

        function isArray(input) {
            return input instanceof Array || Object.prototype.toString.call(input) === '[object Array]';
        }

        function isObject(input) {
            // IE8 will treat undefined and null as object if it wasn't for
            // input != null
            return input != null && Object.prototype.toString.call(input) === '[object Object]';
        }

        function isObjectEmpty(obj) {
            if (Object.getOwnPropertyNames) {
                return (Object.getOwnPropertyNames(obj).length === 0);
            } else {
                var k;
                for (k in obj) {
                    if (obj.hasOwnProperty(k)) {
                        return false;
                    }
                }
                return true;
            }
        }

        function isUndefined(input) {
            return input === void 0;
        }

        function isNumber(input) {
            return typeof input === 'number' || Object.prototype.toString.call(input) === '[object Number]';
        }

        function isDate(input) {
            return input instanceof Date || Object.prototype.toString.call(input) === '[object Date]';
        }

        function map(arr, fn) {
            var res = [], i;
            for (i = 0; i < arr.length; ++i) {
                res.push(fn(arr[i], i));
            }
            return res;
        }

        function hasOwnProp(a, b) {
            return Object.prototype.hasOwnProperty.call(a, b);
        }

        function extend(a, b) {
            for (var i in b) {
                if (hasOwnProp(b, i)) {
                    a[i] = b[i];
                }
            }

            if (hasOwnProp(b, 'toString')) {
                a.toString = b.toString;
            }

            if (hasOwnProp(b, 'valueOf')) {
                a.valueOf = b.valueOf;
            }

            return a;
        }

        function createUTC (input, format, locale, strict) {
            return createLocalOrUTC(input, format, locale, strict, true).utc();
        }

        function defaultParsingFlags() {
            // We need to deep clone this object.
            return {
                empty           : false,
                unusedTokens    : [],
                unusedInput     : [],
                overflow        : -2,
                charsLeftOver   : 0,
                nullInput       : false,
                invalidMonth    : null,
                invalidFormat   : false,
                userInvalidated : false,
                iso             : false,
                parsedDateParts : [],
                meridiem        : null,
                rfc2822         : false,
                weekdayMismatch : false
            };
        }

        function getParsingFlags(m) {
            if (m._pf == null) {
                m._pf = defaultParsingFlags();
            }
            return m._pf;
        }

        var some;
        if (Array.prototype.some) {
            some = Array.prototype.some;
        } else {
            some = function (fun) {
                var t = Object(this);
                var len = t.length >>> 0;

                for (var i = 0; i < len; i++) {
                    if (i in t && fun.call(this, t[i], i, t)) {
                        return true;
                    }
                }

                return false;
            };
        }

        function isValid(m) {
            if (m._isValid == null) {
                var flags = getParsingFlags(m);
                var parsedParts = some.call(flags.parsedDateParts, function (i) {
                    return i != null;
                });
                var isNowValid = !isNaN(m._d.getTime()) &&
                    flags.overflow < 0 &&
                    !flags.empty &&
                    !flags.invalidMonth &&
                    !flags.invalidWeekday &&
                    !flags.weekdayMismatch &&
                    !flags.nullInput &&
                    !flags.invalidFormat &&
                    !flags.userInvalidated &&
                    (!flags.meridiem || (flags.meridiem && parsedParts));

                if (m._strict) {
                    isNowValid = isNowValid &&
                        flags.charsLeftOver === 0 &&
                        flags.unusedTokens.length === 0 &&
                        flags.bigHour === undefined;
                }

                if (Object.isFrozen == null || !Object.isFrozen(m)) {
                    m._isValid = isNowValid;
                }
                else {
                    return isNowValid;
                }
            }
            return m._isValid;
        }

        function createInvalid (flags) {
            var m = createUTC(NaN);
            if (flags != null) {
                extend(getParsingFlags(m), flags);
            }
            else {
                getParsingFlags(m).userInvalidated = true;
            }

            return m;
        }

        // Plugins that add properties should also add the key here (null value),
        // so we can properly clone ourselves.
        var momentProperties = hooks.momentProperties = [];

        function copyConfig(to, from) {
            var i, prop, val;

            if (!isUndefined(from._isAMomentObject)) {
                to._isAMomentObject = from._isAMomentObject;
            }
            if (!isUndefined(from._i)) {
                to._i = from._i;
            }
            if (!isUndefined(from._f)) {
                to._f = from._f;
            }
            if (!isUndefined(from._l)) {
                to._l = from._l;
            }
            if (!isUndefined(from._strict)) {
                to._strict = from._strict;
            }
            if (!isUndefined(from._tzm)) {
                to._tzm = from._tzm;
            }
            if (!isUndefined(from._isUTC)) {
                to._isUTC = from._isUTC;
            }
            if (!isUndefined(from._offset)) {
                to._offset = from._offset;
            }
            if (!isUndefined(from._pf)) {
                to._pf = getParsingFlags(from);
            }
            if (!isUndefined(from._locale)) {
                to._locale = from._locale;
            }

            if (momentProperties.length > 0) {
                for (i = 0; i < momentProperties.length; i++) {
                    prop = momentProperties[i];
                    val = from[prop];
                    if (!isUndefined(val)) {
                        to[prop] = val;
                    }
                }
            }

            return to;
        }

        var updateInProgress = false;

        // Moment prototype object
        function Moment(config) {
            copyConfig(this, config);
            this._d = new Date(config._d != null ? config._d.getTime() : NaN);
            if (!this.isValid()) {
                this._d = new Date(NaN);
            }
            // Prevent infinite loop in case updateOffset creates new moment
            // objects.
            if (updateInProgress === false) {
                updateInProgress = true;
                hooks.updateOffset(this);
                updateInProgress = false;
            }
        }

        function isMoment (obj) {
            return obj instanceof Moment || (obj != null && obj._isAMomentObject != null);
        }

        function absFloor (number) {
            if (number < 0) {
                // -0 -> 0
                return Math.ceil(number) || 0;
            } else {
                return Math.floor(number);
            }
        }

        function toInt(argumentForCoercion) {
            var coercedNumber = +argumentForCoercion,
                value = 0;

            if (coercedNumber !== 0 && isFinite(coercedNumber)) {
                value = absFloor(coercedNumber);
            }

            return value;
        }

        // compare two arrays, return the number of differences
        function compareArrays(array1, array2, dontConvert) {
            var len = Math.min(array1.length, array2.length),
                lengthDiff = Math.abs(array1.length - array2.length),
                diffs = 0,
                i;
            for (i = 0; i < len; i++) {
                if ((dontConvert && array1[i] !== array2[i]) ||
                    (!dontConvert && toInt(array1[i]) !== toInt(array2[i]))) {
                    diffs++;
                }
            }
            return diffs + lengthDiff;
        }

        function warn(msg) {
            if (hooks.suppressDeprecationWarnings === false &&
                    (typeof console !==  'undefined') && console.warn) {
                console.warn('Deprecation warning: ' + msg);
            }
        }

        function deprecate(msg, fn) {
            var firstTime = true;

            return extend(function () {
                if (hooks.deprecationHandler != null) {
                    hooks.deprecationHandler(null, msg);
                }
                if (firstTime) {
                    var args = [];
                    var arg;
                    for (var i = 0; i < arguments.length; i++) {
                        arg = '';
                        if (typeof arguments[i] === 'object') {
                            arg += '\n[' + i + '] ';
                            for (var key in arguments[0]) {
                                arg += key + ': ' + arguments[0][key] + ', ';
                            }
                            arg = arg.slice(0, -2); // Remove trailing comma and space
                        } else {
                            arg = arguments[i];
                        }
                        args.push(arg);
                    }
                    warn(msg + '\nArguments: ' + Array.prototype.slice.call(args).join('') + '\n' + (new Error()).stack);
                    firstTime = false;
                }
                return fn.apply(this, arguments);
            }, fn);
        }

        var deprecations = {};

        function deprecateSimple(name, msg) {
            if (hooks.deprecationHandler != null) {
                hooks.deprecationHandler(name, msg);
            }
            if (!deprecations[name]) {
                warn(msg);
                deprecations[name] = true;
            }
        }

        hooks.suppressDeprecationWarnings = false;
        hooks.deprecationHandler = null;

        function isFunction(input) {
            return input instanceof Function || Object.prototype.toString.call(input) === '[object Function]';
        }

        function set (config) {
            var prop, i;
            for (i in config) {
                prop = config[i];
                if (isFunction(prop)) {
                    this[i] = prop;
                } else {
                    this['_' + i] = prop;
                }
            }
            this._config = config;
            // Lenient ordinal parsing accepts just a number in addition to
            // number + (possibly) stuff coming from _dayOfMonthOrdinalParse.
            // TODO: Remove "ordinalParse" fallback in next major release.
            this._dayOfMonthOrdinalParseLenient = new RegExp(
                (this._dayOfMonthOrdinalParse.source || this._ordinalParse.source) +
                    '|' + (/\d{1,2}/).source);
        }

        function mergeConfigs(parentConfig, childConfig) {
            var res = extend({}, parentConfig), prop;
            for (prop in childConfig) {
                if (hasOwnProp(childConfig, prop)) {
                    if (isObject(parentConfig[prop]) && isObject(childConfig[prop])) {
                        res[prop] = {};
                        extend(res[prop], parentConfig[prop]);
                        extend(res[prop], childConfig[prop]);
                    } else if (childConfig[prop] != null) {
                        res[prop] = childConfig[prop];
                    } else {
                        delete res[prop];
                    }
                }
            }
            for (prop in parentConfig) {
                if (hasOwnProp(parentConfig, prop) &&
                        !hasOwnProp(childConfig, prop) &&
                        isObject(parentConfig[prop])) {
                    // make sure changes to properties don't modify parent config
                    res[prop] = extend({}, res[prop]);
                }
            }
            return res;
        }

        function Locale(config) {
            if (config != null) {
                this.set(config);
            }
        }

        var keys;

        if (Object.keys) {
            keys = Object.keys;
        } else {
            keys = function (obj) {
                var i, res = [];
                for (i in obj) {
                    if (hasOwnProp(obj, i)) {
                        res.push(i);
                    }
                }
                return res;
            };
        }

        var defaultCalendar = {
            sameDay : '[Today at] LT',
            nextDay : '[Tomorrow at] LT',
            nextWeek : 'dddd [at] LT',
            lastDay : '[Yesterday at] LT',
            lastWeek : '[Last] dddd [at] LT',
            sameElse : 'L'
        };

        function calendar (key, mom, now) {
            var output = this._calendar[key] || this._calendar['sameElse'];
            return isFunction(output) ? output.call(mom, now) : output;
        }

        var defaultLongDateFormat = {
            LTS  : 'h:mm:ss A',
            LT   : 'h:mm A',
            L    : 'MM/DD/YYYY',
            LL   : 'MMMM D, YYYY',
            LLL  : 'MMMM D, YYYY h:mm A',
            LLLL : 'dddd, MMMM D, YYYY h:mm A'
        };

        function longDateFormat (key) {
            var format = this._longDateFormat[key],
                formatUpper = this._longDateFormat[key.toUpperCase()];

            if (format || !formatUpper) {
                return format;
            }

            this._longDateFormat[key] = formatUpper.replace(/MMMM|MM|DD|dddd/g, function (val) {
                return val.slice(1);
            });

            return this._longDateFormat[key];
        }

        var defaultInvalidDate = 'Invalid date';

        function invalidDate () {
            return this._invalidDate;
        }

        var defaultOrdinal = '%d';
        var defaultDayOfMonthOrdinalParse = /\d{1,2}/;

        function ordinal (number) {
            return this._ordinal.replace('%d', number);
        }

        var defaultRelativeTime = {
            future : 'in %s',
            past   : '%s ago',
            s  : 'a few seconds',
            ss : '%d seconds',
            m  : 'a minute',
            mm : '%d minutes',
            h  : 'an hour',
            hh : '%d hours',
            d  : 'a day',
            dd : '%d days',
            M  : 'a month',
            MM : '%d months',
            y  : 'a year',
            yy : '%d years'
        };

        function relativeTime (number, withoutSuffix, string, isFuture) {
            var output = this._relativeTime[string];
            return (isFunction(output)) ?
                output(number, withoutSuffix, string, isFuture) :
                output.replace(/%d/i, number);
        }

        function pastFuture (diff, output) {
            var format = this._relativeTime[diff > 0 ? 'future' : 'past'];
            return isFunction(format) ? format(output) : format.replace(/%s/i, output);
        }

        var aliases = {};

        function addUnitAlias (unit, shorthand) {
            var lowerCase = unit.toLowerCase();
            aliases[lowerCase] = aliases[lowerCase + 's'] = aliases[shorthand] = unit;
        }

        function normalizeUnits(units) {
            return typeof units === 'string' ? aliases[units] || aliases[units.toLowerCase()] : undefined;
        }

        function normalizeObjectUnits(inputObject) {
            var normalizedInput = {},
                normalizedProp,
                prop;

            for (prop in inputObject) {
                if (hasOwnProp(inputObject, prop)) {
                    normalizedProp = normalizeUnits(prop);
                    if (normalizedProp) {
                        normalizedInput[normalizedProp] = inputObject[prop];
                    }
                }
            }

            return normalizedInput;
        }

        var priorities = {};

        function addUnitPriority(unit, priority) {
            priorities[unit] = priority;
        }

        function getPrioritizedUnits(unitsObj) {
            var units = [];
            for (var u in unitsObj) {
                units.push({unit: u, priority: priorities[u]});
            }
            units.sort(function (a, b) {
                return a.priority - b.priority;
            });
            return units;
        }

        function zeroFill(number, targetLength, forceSign) {
            var absNumber = '' + Math.abs(number),
                zerosToFill = targetLength - absNumber.length,
                sign = number >= 0;
            return (sign ? (forceSign ? '+' : '') : '-') +
                Math.pow(10, Math.max(0, zerosToFill)).toString().substr(1) + absNumber;
        }

        var formattingTokens = /(\[[^\[]*\])|(\\)?([Hh]mm(ss)?|Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Qo?|YYYYYY|YYYYY|YYYY|YY|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|.)/g;

        var localFormattingTokens = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;

        var formatFunctions = {};

        var formatTokenFunctions = {};

        // token:    'M'
        // padded:   ['MM', 2]
        // ordinal:  'Mo'
        // callback: function () { this.month() + 1 }
        function addFormatToken (token, padded, ordinal, callback) {
            var func = callback;
            if (typeof callback === 'string') {
                func = function () {
                    return this[callback]();
                };
            }
            if (token) {
                formatTokenFunctions[token] = func;
            }
            if (padded) {
                formatTokenFunctions[padded[0]] = function () {
                    return zeroFill(func.apply(this, arguments), padded[1], padded[2]);
                };
            }
            if (ordinal) {
                formatTokenFunctions[ordinal] = function () {
                    return this.localeData().ordinal(func.apply(this, arguments), token);
                };
            }
        }

        function removeFormattingTokens(input) {
            if (input.match(/\[[\s\S]/)) {
                return input.replace(/^\[|\]$/g, '');
            }
            return input.replace(/\\/g, '');
        }

        function makeFormatFunction(format) {
            var array = format.match(formattingTokens), i, length;

            for (i = 0, length = array.length; i < length; i++) {
                if (formatTokenFunctions[array[i]]) {
                    array[i] = formatTokenFunctions[array[i]];
                } else {
                    array[i] = removeFormattingTokens(array[i]);
                }
            }

            return function (mom) {
                var output = '', i;
                for (i = 0; i < length; i++) {
                    output += isFunction(array[i]) ? array[i].call(mom, format) : array[i];
                }
                return output;
            };
        }

        // format date using native date object
        function formatMoment(m, format) {
            if (!m.isValid()) {
                return m.localeData().invalidDate();
            }

            format = expandFormat(format, m.localeData());
            formatFunctions[format] = formatFunctions[format] || makeFormatFunction(format);

            return formatFunctions[format](m);
        }

        function expandFormat(format, locale) {
            var i = 5;

            function replaceLongDateFormatTokens(input) {
                return locale.longDateFormat(input) || input;
            }

            localFormattingTokens.lastIndex = 0;
            while (i >= 0 && localFormattingTokens.test(format)) {
                format = format.replace(localFormattingTokens, replaceLongDateFormatTokens);
                localFormattingTokens.lastIndex = 0;
                i -= 1;
            }

            return format;
        }

        var match1         = /\d/;            //       0 - 9
        var match2         = /\d\d/;          //      00 - 99
        var match3         = /\d{3}/;         //     000 - 999
        var match4         = /\d{4}/;         //    0000 - 9999
        var match6         = /[+-]?\d{6}/;    // -999999 - 999999
        var match1to2      = /\d\d?/;         //       0 - 99
        var match3to4      = /\d\d\d\d?/;     //     999 - 9999
        var match5to6      = /\d\d\d\d\d\d?/; //   99999 - 999999
        var match1to3      = /\d{1,3}/;       //       0 - 999
        var match1to4      = /\d{1,4}/;       //       0 - 9999
        var match1to6      = /[+-]?\d{1,6}/;  // -999999 - 999999

        var matchUnsigned  = /\d+/;           //       0 - inf
        var matchSigned    = /[+-]?\d+/;      //    -inf - inf

        var matchOffset    = /Z|[+-]\d\d:?\d\d/gi; // +00:00 -00:00 +0000 -0000 or Z
        var matchShortOffset = /Z|[+-]\d\d(?::?\d\d)?/gi; // +00 -00 +00:00 -00:00 +0000 -0000 or Z

        var matchTimestamp = /[+-]?\d+(\.\d{1,3})?/; // 123456789 123456789.123

        // any word (or two) characters or numbers including two/three word month in arabic.
        // includes scottish gaelic two word and hyphenated months
        var matchWord = /[0-9]{0,256}['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFF07\uFF10-\uFFEF]{1,256}|[\u0600-\u06FF\/]{1,256}(\s*?[\u0600-\u06FF]{1,256}){1,2}/i;

        var regexes = {};

        function addRegexToken (token, regex, strictRegex) {
            regexes[token] = isFunction(regex) ? regex : function (isStrict, localeData) {
                return (isStrict && strictRegex) ? strictRegex : regex;
            };
        }

        function getParseRegexForToken (token, config) {
            if (!hasOwnProp(regexes, token)) {
                return new RegExp(unescapeFormat(token));
            }

            return regexes[token](config._strict, config._locale);
        }

        // Code from http://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
        function unescapeFormat(s) {
            return regexEscape(s.replace('\\', '').replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function (matched, p1, p2, p3, p4) {
                return p1 || p2 || p3 || p4;
            }));
        }

        function regexEscape(s) {
            return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        }

        var tokens = {};

        function addParseToken (token, callback) {
            var i, func = callback;
            if (typeof token === 'string') {
                token = [token];
            }
            if (isNumber(callback)) {
                func = function (input, array) {
                    array[callback] = toInt(input);
                };
            }
            for (i = 0; i < token.length; i++) {
                tokens[token[i]] = func;
            }
        }

        function addWeekParseToken (token, callback) {
            addParseToken(token, function (input, array, config, token) {
                config._w = config._w || {};
                callback(input, config._w, config, token);
            });
        }

        function addTimeToArrayFromToken(token, input, config) {
            if (input != null && hasOwnProp(tokens, token)) {
                tokens[token](input, config._a, config, token);
            }
        }

        var YEAR = 0;
        var MONTH = 1;
        var DATE = 2;
        var HOUR = 3;
        var MINUTE = 4;
        var SECOND = 5;
        var MILLISECOND = 6;
        var WEEK = 7;
        var WEEKDAY = 8;

        // FORMATTING

        addFormatToken('Y', 0, 0, function () {
            var y = this.year();
            return y <= 9999 ? '' + y : '+' + y;
        });

        addFormatToken(0, ['YY', 2], 0, function () {
            return this.year() % 100;
        });

        addFormatToken(0, ['YYYY',   4],       0, 'year');
        addFormatToken(0, ['YYYYY',  5],       0, 'year');
        addFormatToken(0, ['YYYYYY', 6, true], 0, 'year');

        // ALIASES

        addUnitAlias('year', 'y');

        // PRIORITIES

        addUnitPriority('year', 1);

        // PARSING

        addRegexToken('Y',      matchSigned);
        addRegexToken('YY',     match1to2, match2);
        addRegexToken('YYYY',   match1to4, match4);
        addRegexToken('YYYYY',  match1to6, match6);
        addRegexToken('YYYYYY', match1to6, match6);

        addParseToken(['YYYYY', 'YYYYYY'], YEAR);
        addParseToken('YYYY', function (input, array) {
            array[YEAR] = input.length === 2 ? hooks.parseTwoDigitYear(input) : toInt(input);
        });
        addParseToken('YY', function (input, array) {
            array[YEAR] = hooks.parseTwoDigitYear(input);
        });
        addParseToken('Y', function (input, array) {
            array[YEAR] = parseInt(input, 10);
        });

        // HELPERS

        function daysInYear(year) {
            return isLeapYear(year) ? 366 : 365;
        }

        function isLeapYear(year) {
            return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        }

        // HOOKS

        hooks.parseTwoDigitYear = function (input) {
            return toInt(input) + (toInt(input) > 68 ? 1900 : 2000);
        };

        // MOMENTS

        var getSetYear = makeGetSet('FullYear', true);

        function getIsLeapYear () {
            return isLeapYear(this.year());
        }

        function makeGetSet (unit, keepTime) {
            return function (value) {
                if (value != null) {
                    set$1(this, unit, value);
                    hooks.updateOffset(this, keepTime);
                    return this;
                } else {
                    return get(this, unit);
                }
            };
        }

        function get (mom, unit) {
            return mom.isValid() ?
                mom._d['get' + (mom._isUTC ? 'UTC' : '') + unit]() : NaN;
        }

        function set$1 (mom, unit, value) {
            if (mom.isValid() && !isNaN(value)) {
                if (unit === 'FullYear' && isLeapYear(mom.year()) && mom.month() === 1 && mom.date() === 29) {
                    mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value, mom.month(), daysInMonth(value, mom.month()));
                }
                else {
                    mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value);
                }
            }
        }

        // MOMENTS

        function stringGet (units) {
            units = normalizeUnits(units);
            if (isFunction(this[units])) {
                return this[units]();
            }
            return this;
        }


        function stringSet (units, value) {
            if (typeof units === 'object') {
                units = normalizeObjectUnits(units);
                var prioritized = getPrioritizedUnits(units);
                for (var i = 0; i < prioritized.length; i++) {
                    this[prioritized[i].unit](units[prioritized[i].unit]);
                }
            } else {
                units = normalizeUnits(units);
                if (isFunction(this[units])) {
                    return this[units](value);
                }
            }
            return this;
        }

        function mod(n, x) {
            return ((n % x) + x) % x;
        }

        var indexOf;

        if (Array.prototype.indexOf) {
            indexOf = Array.prototype.indexOf;
        } else {
            indexOf = function (o) {
                // I know
                var i;
                for (i = 0; i < this.length; ++i) {
                    if (this[i] === o) {
                        return i;
                    }
                }
                return -1;
            };
        }

        function daysInMonth(year, month) {
            if (isNaN(year) || isNaN(month)) {
                return NaN;
            }
            var modMonth = mod(month, 12);
            year += (month - modMonth) / 12;
            return modMonth === 1 ? (isLeapYear(year) ? 29 : 28) : (31 - modMonth % 7 % 2);
        }

        // FORMATTING

        addFormatToken('M', ['MM', 2], 'Mo', function () {
            return this.month() + 1;
        });

        addFormatToken('MMM', 0, 0, function (format) {
            return this.localeData().monthsShort(this, format);
        });

        addFormatToken('MMMM', 0, 0, function (format) {
            return this.localeData().months(this, format);
        });

        // ALIASES

        addUnitAlias('month', 'M');

        // PRIORITY

        addUnitPriority('month', 8);

        // PARSING

        addRegexToken('M',    match1to2);
        addRegexToken('MM',   match1to2, match2);
        addRegexToken('MMM',  function (isStrict, locale) {
            return locale.monthsShortRegex(isStrict);
        });
        addRegexToken('MMMM', function (isStrict, locale) {
            return locale.monthsRegex(isStrict);
        });

        addParseToken(['M', 'MM'], function (input, array) {
            array[MONTH] = toInt(input) - 1;
        });

        addParseToken(['MMM', 'MMMM'], function (input, array, config, token) {
            var month = config._locale.monthsParse(input, token, config._strict);
            // if we didn't find a month name, mark the date as invalid.
            if (month != null) {
                array[MONTH] = month;
            } else {
                getParsingFlags(config).invalidMonth = input;
            }
        });

        // LOCALES

        var MONTHS_IN_FORMAT = /D[oD]?(\[[^\[\]]*\]|\s)+MMMM?/;
        var defaultLocaleMonths = 'January_February_March_April_May_June_July_August_September_October_November_December'.split('_');
        function localeMonths (m, format) {
            if (!m) {
                return isArray(this._months) ? this._months :
                    this._months['standalone'];
            }
            return isArray(this._months) ? this._months[m.month()] :
                this._months[(this._months.isFormat || MONTHS_IN_FORMAT).test(format) ? 'format' : 'standalone'][m.month()];
        }

        var defaultLocaleMonthsShort = 'Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec'.split('_');
        function localeMonthsShort (m, format) {
            if (!m) {
                return isArray(this._monthsShort) ? this._monthsShort :
                    this._monthsShort['standalone'];
            }
            return isArray(this._monthsShort) ? this._monthsShort[m.month()] :
                this._monthsShort[MONTHS_IN_FORMAT.test(format) ? 'format' : 'standalone'][m.month()];
        }

        function handleStrictParse(monthName, format, strict) {
            var i, ii, mom, llc = monthName.toLocaleLowerCase();
            if (!this._monthsParse) {
                // this is not used
                this._monthsParse = [];
                this._longMonthsParse = [];
                this._shortMonthsParse = [];
                for (i = 0; i < 12; ++i) {
                    mom = createUTC([2000, i]);
                    this._shortMonthsParse[i] = this.monthsShort(mom, '').toLocaleLowerCase();
                    this._longMonthsParse[i] = this.months(mom, '').toLocaleLowerCase();
                }
            }

            if (strict) {
                if (format === 'MMM') {
                    ii = indexOf.call(this._shortMonthsParse, llc);
                    return ii !== -1 ? ii : null;
                } else {
                    ii = indexOf.call(this._longMonthsParse, llc);
                    return ii !== -1 ? ii : null;
                }
            } else {
                if (format === 'MMM') {
                    ii = indexOf.call(this._shortMonthsParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._longMonthsParse, llc);
                    return ii !== -1 ? ii : null;
                } else {
                    ii = indexOf.call(this._longMonthsParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._shortMonthsParse, llc);
                    return ii !== -1 ? ii : null;
                }
            }
        }

        function localeMonthsParse (monthName, format, strict) {
            var i, mom, regex;

            if (this._monthsParseExact) {
                return handleStrictParse.call(this, monthName, format, strict);
            }

            if (!this._monthsParse) {
                this._monthsParse = [];
                this._longMonthsParse = [];
                this._shortMonthsParse = [];
            }

            // TODO: add sorting
            // Sorting makes sure if one month (or abbr) is a prefix of another
            // see sorting in computeMonthsParse
            for (i = 0; i < 12; i++) {
                // make the regex if we don't have it already
                mom = createUTC([2000, i]);
                if (strict && !this._longMonthsParse[i]) {
                    this._longMonthsParse[i] = new RegExp('^' + this.months(mom, '').replace('.', '') + '$', 'i');
                    this._shortMonthsParse[i] = new RegExp('^' + this.monthsShort(mom, '').replace('.', '') + '$', 'i');
                }
                if (!strict && !this._monthsParse[i]) {
                    regex = '^' + this.months(mom, '') + '|^' + this.monthsShort(mom, '');
                    this._monthsParse[i] = new RegExp(regex.replace('.', ''), 'i');
                }
                // test the regex
                if (strict && format === 'MMMM' && this._longMonthsParse[i].test(monthName)) {
                    return i;
                } else if (strict && format === 'MMM' && this._shortMonthsParse[i].test(monthName)) {
                    return i;
                } else if (!strict && this._monthsParse[i].test(monthName)) {
                    return i;
                }
            }
        }

        // MOMENTS

        function setMonth (mom, value) {
            var dayOfMonth;

            if (!mom.isValid()) {
                // No op
                return mom;
            }

            if (typeof value === 'string') {
                if (/^\d+$/.test(value)) {
                    value = toInt(value);
                } else {
                    value = mom.localeData().monthsParse(value);
                    // TODO: Another silent failure?
                    if (!isNumber(value)) {
                        return mom;
                    }
                }
            }

            dayOfMonth = Math.min(mom.date(), daysInMonth(mom.year(), value));
            mom._d['set' + (mom._isUTC ? 'UTC' : '') + 'Month'](value, dayOfMonth);
            return mom;
        }

        function getSetMonth (value) {
            if (value != null) {
                setMonth(this, value);
                hooks.updateOffset(this, true);
                return this;
            } else {
                return get(this, 'Month');
            }
        }

        function getDaysInMonth () {
            return daysInMonth(this.year(), this.month());
        }

        var defaultMonthsShortRegex = matchWord;
        function monthsShortRegex (isStrict) {
            if (this._monthsParseExact) {
                if (!hasOwnProp(this, '_monthsRegex')) {
                    computeMonthsParse.call(this);
                }
                if (isStrict) {
                    return this._monthsShortStrictRegex;
                } else {
                    return this._monthsShortRegex;
                }
            } else {
                if (!hasOwnProp(this, '_monthsShortRegex')) {
                    this._monthsShortRegex = defaultMonthsShortRegex;
                }
                return this._monthsShortStrictRegex && isStrict ?
                    this._monthsShortStrictRegex : this._monthsShortRegex;
            }
        }

        var defaultMonthsRegex = matchWord;
        function monthsRegex (isStrict) {
            if (this._monthsParseExact) {
                if (!hasOwnProp(this, '_monthsRegex')) {
                    computeMonthsParse.call(this);
                }
                if (isStrict) {
                    return this._monthsStrictRegex;
                } else {
                    return this._monthsRegex;
                }
            } else {
                if (!hasOwnProp(this, '_monthsRegex')) {
                    this._monthsRegex = defaultMonthsRegex;
                }
                return this._monthsStrictRegex && isStrict ?
                    this._monthsStrictRegex : this._monthsRegex;
            }
        }

        function computeMonthsParse () {
            function cmpLenRev(a, b) {
                return b.length - a.length;
            }

            var shortPieces = [], longPieces = [], mixedPieces = [],
                i, mom;
            for (i = 0; i < 12; i++) {
                // make the regex if we don't have it already
                mom = createUTC([2000, i]);
                shortPieces.push(this.monthsShort(mom, ''));
                longPieces.push(this.months(mom, ''));
                mixedPieces.push(this.months(mom, ''));
                mixedPieces.push(this.monthsShort(mom, ''));
            }
            // Sorting makes sure if one month (or abbr) is a prefix of another it
            // will match the longer piece.
            shortPieces.sort(cmpLenRev);
            longPieces.sort(cmpLenRev);
            mixedPieces.sort(cmpLenRev);
            for (i = 0; i < 12; i++) {
                shortPieces[i] = regexEscape(shortPieces[i]);
                longPieces[i] = regexEscape(longPieces[i]);
            }
            for (i = 0; i < 24; i++) {
                mixedPieces[i] = regexEscape(mixedPieces[i]);
            }

            this._monthsRegex = new RegExp('^(' + mixedPieces.join('|') + ')', 'i');
            this._monthsShortRegex = this._monthsRegex;
            this._monthsStrictRegex = new RegExp('^(' + longPieces.join('|') + ')', 'i');
            this._monthsShortStrictRegex = new RegExp('^(' + shortPieces.join('|') + ')', 'i');
        }

        function createDate (y, m, d, h, M, s, ms) {
            // can't just apply() to create a date:
            // https://stackoverflow.com/q/181348
            var date = new Date(y, m, d, h, M, s, ms);

            // the date constructor remaps years 0-99 to 1900-1999
            if (y < 100 && y >= 0 && isFinite(date.getFullYear())) {
                date.setFullYear(y);
            }
            return date;
        }

        function createUTCDate (y) {
            var date = new Date(Date.UTC.apply(null, arguments));

            // the Date.UTC function remaps years 0-99 to 1900-1999
            if (y < 100 && y >= 0 && isFinite(date.getUTCFullYear())) {
                date.setUTCFullYear(y);
            }
            return date;
        }

        // start-of-first-week - start-of-year
        function firstWeekOffset(year, dow, doy) {
            var // first-week day -- which january is always in the first week (4 for iso, 1 for other)
                fwd = 7 + dow - doy,
                // first-week day local weekday -- which local weekday is fwd
                fwdlw = (7 + createUTCDate(year, 0, fwd).getUTCDay() - dow) % 7;

            return -fwdlw + fwd - 1;
        }

        // https://en.wikipedia.org/wiki/ISO_week_date#Calculating_a_date_given_the_year.2C_week_number_and_weekday
        function dayOfYearFromWeeks(year, week, weekday, dow, doy) {
            var localWeekday = (7 + weekday - dow) % 7,
                weekOffset = firstWeekOffset(year, dow, doy),
                dayOfYear = 1 + 7 * (week - 1) + localWeekday + weekOffset,
                resYear, resDayOfYear;

            if (dayOfYear <= 0) {
                resYear = year - 1;
                resDayOfYear = daysInYear(resYear) + dayOfYear;
            } else if (dayOfYear > daysInYear(year)) {
                resYear = year + 1;
                resDayOfYear = dayOfYear - daysInYear(year);
            } else {
                resYear = year;
                resDayOfYear = dayOfYear;
            }

            return {
                year: resYear,
                dayOfYear: resDayOfYear
            };
        }

        function weekOfYear(mom, dow, doy) {
            var weekOffset = firstWeekOffset(mom.year(), dow, doy),
                week = Math.floor((mom.dayOfYear() - weekOffset - 1) / 7) + 1,
                resWeek, resYear;

            if (week < 1) {
                resYear = mom.year() - 1;
                resWeek = week + weeksInYear(resYear, dow, doy);
            } else if (week > weeksInYear(mom.year(), dow, doy)) {
                resWeek = week - weeksInYear(mom.year(), dow, doy);
                resYear = mom.year() + 1;
            } else {
                resYear = mom.year();
                resWeek = week;
            }

            return {
                week: resWeek,
                year: resYear
            };
        }

        function weeksInYear(year, dow, doy) {
            var weekOffset = firstWeekOffset(year, dow, doy),
                weekOffsetNext = firstWeekOffset(year + 1, dow, doy);
            return (daysInYear(year) - weekOffset + weekOffsetNext) / 7;
        }

        // FORMATTING

        addFormatToken('w', ['ww', 2], 'wo', 'week');
        addFormatToken('W', ['WW', 2], 'Wo', 'isoWeek');

        // ALIASES

        addUnitAlias('week', 'w');
        addUnitAlias('isoWeek', 'W');

        // PRIORITIES

        addUnitPriority('week', 5);
        addUnitPriority('isoWeek', 5);

        // PARSING

        addRegexToken('w',  match1to2);
        addRegexToken('ww', match1to2, match2);
        addRegexToken('W',  match1to2);
        addRegexToken('WW', match1to2, match2);

        addWeekParseToken(['w', 'ww', 'W', 'WW'], function (input, week, config, token) {
            week[token.substr(0, 1)] = toInt(input);
        });

        // HELPERS

        // LOCALES

        function localeWeek (mom) {
            return weekOfYear(mom, this._week.dow, this._week.doy).week;
        }

        var defaultLocaleWeek = {
            dow : 0, // Sunday is the first day of the week.
            doy : 6  // The week that contains Jan 1st is the first week of the year.
        };

        function localeFirstDayOfWeek () {
            return this._week.dow;
        }

        function localeFirstDayOfYear () {
            return this._week.doy;
        }

        // MOMENTS

        function getSetWeek (input) {
            var week = this.localeData().week(this);
            return input == null ? week : this.add((input - week) * 7, 'd');
        }

        function getSetISOWeek (input) {
            var week = weekOfYear(this, 1, 4).week;
            return input == null ? week : this.add((input - week) * 7, 'd');
        }

        // FORMATTING

        addFormatToken('d', 0, 'do', 'day');

        addFormatToken('dd', 0, 0, function (format) {
            return this.localeData().weekdaysMin(this, format);
        });

        addFormatToken('ddd', 0, 0, function (format) {
            return this.localeData().weekdaysShort(this, format);
        });

        addFormatToken('dddd', 0, 0, function (format) {
            return this.localeData().weekdays(this, format);
        });

        addFormatToken('e', 0, 0, 'weekday');
        addFormatToken('E', 0, 0, 'isoWeekday');

        // ALIASES

        addUnitAlias('day', 'd');
        addUnitAlias('weekday', 'e');
        addUnitAlias('isoWeekday', 'E');

        // PRIORITY
        addUnitPriority('day', 11);
        addUnitPriority('weekday', 11);
        addUnitPriority('isoWeekday', 11);

        // PARSING

        addRegexToken('d',    match1to2);
        addRegexToken('e',    match1to2);
        addRegexToken('E',    match1to2);
        addRegexToken('dd',   function (isStrict, locale) {
            return locale.weekdaysMinRegex(isStrict);
        });
        addRegexToken('ddd',   function (isStrict, locale) {
            return locale.weekdaysShortRegex(isStrict);
        });
        addRegexToken('dddd',   function (isStrict, locale) {
            return locale.weekdaysRegex(isStrict);
        });

        addWeekParseToken(['dd', 'ddd', 'dddd'], function (input, week, config, token) {
            var weekday = config._locale.weekdaysParse(input, token, config._strict);
            // if we didn't get a weekday name, mark the date as invalid
            if (weekday != null) {
                week.d = weekday;
            } else {
                getParsingFlags(config).invalidWeekday = input;
            }
        });

        addWeekParseToken(['d', 'e', 'E'], function (input, week, config, token) {
            week[token] = toInt(input);
        });

        // HELPERS

        function parseWeekday(input, locale) {
            if (typeof input !== 'string') {
                return input;
            }

            if (!isNaN(input)) {
                return parseInt(input, 10);
            }

            input = locale.weekdaysParse(input);
            if (typeof input === 'number') {
                return input;
            }

            return null;
        }

        function parseIsoWeekday(input, locale) {
            if (typeof input === 'string') {
                return locale.weekdaysParse(input) % 7 || 7;
            }
            return isNaN(input) ? null : input;
        }

        // LOCALES

        var defaultLocaleWeekdays = 'Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday'.split('_');
        function localeWeekdays (m, format) {
            if (!m) {
                return isArray(this._weekdays) ? this._weekdays :
                    this._weekdays['standalone'];
            }
            return isArray(this._weekdays) ? this._weekdays[m.day()] :
                this._weekdays[this._weekdays.isFormat.test(format) ? 'format' : 'standalone'][m.day()];
        }

        var defaultLocaleWeekdaysShort = 'Sun_Mon_Tue_Wed_Thu_Fri_Sat'.split('_');
        function localeWeekdaysShort (m) {
            return (m) ? this._weekdaysShort[m.day()] : this._weekdaysShort;
        }

        var defaultLocaleWeekdaysMin = 'Su_Mo_Tu_We_Th_Fr_Sa'.split('_');
        function localeWeekdaysMin (m) {
            return (m) ? this._weekdaysMin[m.day()] : this._weekdaysMin;
        }

        function handleStrictParse$1(weekdayName, format, strict) {
            var i, ii, mom, llc = weekdayName.toLocaleLowerCase();
            if (!this._weekdaysParse) {
                this._weekdaysParse = [];
                this._shortWeekdaysParse = [];
                this._minWeekdaysParse = [];

                for (i = 0; i < 7; ++i) {
                    mom = createUTC([2000, 1]).day(i);
                    this._minWeekdaysParse[i] = this.weekdaysMin(mom, '').toLocaleLowerCase();
                    this._shortWeekdaysParse[i] = this.weekdaysShort(mom, '').toLocaleLowerCase();
                    this._weekdaysParse[i] = this.weekdays(mom, '').toLocaleLowerCase();
                }
            }

            if (strict) {
                if (format === 'dddd') {
                    ii = indexOf.call(this._weekdaysParse, llc);
                    return ii !== -1 ? ii : null;
                } else if (format === 'ddd') {
                    ii = indexOf.call(this._shortWeekdaysParse, llc);
                    return ii !== -1 ? ii : null;
                } else {
                    ii = indexOf.call(this._minWeekdaysParse, llc);
                    return ii !== -1 ? ii : null;
                }
            } else {
                if (format === 'dddd') {
                    ii = indexOf.call(this._weekdaysParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._shortWeekdaysParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._minWeekdaysParse, llc);
                    return ii !== -1 ? ii : null;
                } else if (format === 'ddd') {
                    ii = indexOf.call(this._shortWeekdaysParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._weekdaysParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._minWeekdaysParse, llc);
                    return ii !== -1 ? ii : null;
                } else {
                    ii = indexOf.call(this._minWeekdaysParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._weekdaysParse, llc);
                    if (ii !== -1) {
                        return ii;
                    }
                    ii = indexOf.call(this._shortWeekdaysParse, llc);
                    return ii !== -1 ? ii : null;
                }
            }
        }

        function localeWeekdaysParse (weekdayName, format, strict) {
            var i, mom, regex;

            if (this._weekdaysParseExact) {
                return handleStrictParse$1.call(this, weekdayName, format, strict);
            }

            if (!this._weekdaysParse) {
                this._weekdaysParse = [];
                this._minWeekdaysParse = [];
                this._shortWeekdaysParse = [];
                this._fullWeekdaysParse = [];
            }

            for (i = 0; i < 7; i++) {
                // make the regex if we don't have it already

                mom = createUTC([2000, 1]).day(i);
                if (strict && !this._fullWeekdaysParse[i]) {
                    this._fullWeekdaysParse[i] = new RegExp('^' + this.weekdays(mom, '').replace('.', '\.?') + '$', 'i');
                    this._shortWeekdaysParse[i] = new RegExp('^' + this.weekdaysShort(mom, '').replace('.', '\.?') + '$', 'i');
                    this._minWeekdaysParse[i] = new RegExp('^' + this.weekdaysMin(mom, '').replace('.', '\.?') + '$', 'i');
                }
                if (!this._weekdaysParse[i]) {
                    regex = '^' + this.weekdays(mom, '') + '|^' + this.weekdaysShort(mom, '') + '|^' + this.weekdaysMin(mom, '');
                    this._weekdaysParse[i] = new RegExp(regex.replace('.', ''), 'i');
                }
                // test the regex
                if (strict && format === 'dddd' && this._fullWeekdaysParse[i].test(weekdayName)) {
                    return i;
                } else if (strict && format === 'ddd' && this._shortWeekdaysParse[i].test(weekdayName)) {
                    return i;
                } else if (strict && format === 'dd' && this._minWeekdaysParse[i].test(weekdayName)) {
                    return i;
                } else if (!strict && this._weekdaysParse[i].test(weekdayName)) {
                    return i;
                }
            }
        }

        // MOMENTS

        function getSetDayOfWeek (input) {
            if (!this.isValid()) {
                return input != null ? this : NaN;
            }
            var day = this._isUTC ? this._d.getUTCDay() : this._d.getDay();
            if (input != null) {
                input = parseWeekday(input, this.localeData());
                return this.add(input - day, 'd');
            } else {
                return day;
            }
        }

        function getSetLocaleDayOfWeek (input) {
            if (!this.isValid()) {
                return input != null ? this : NaN;
            }
            var weekday = (this.day() + 7 - this.localeData()._week.dow) % 7;
            return input == null ? weekday : this.add(input - weekday, 'd');
        }

        function getSetISODayOfWeek (input) {
            if (!this.isValid()) {
                return input != null ? this : NaN;
            }

            // behaves the same as moment#day except
            // as a getter, returns 7 instead of 0 (1-7 range instead of 0-6)
            // as a setter, sunday should belong to the previous week.

            if (input != null) {
                var weekday = parseIsoWeekday(input, this.localeData());
                return this.day(this.day() % 7 ? weekday : weekday - 7);
            } else {
                return this.day() || 7;
            }
        }

        var defaultWeekdaysRegex = matchWord;
        function weekdaysRegex (isStrict) {
            if (this._weekdaysParseExact) {
                if (!hasOwnProp(this, '_weekdaysRegex')) {
                    computeWeekdaysParse.call(this);
                }
                if (isStrict) {
                    return this._weekdaysStrictRegex;
                } else {
                    return this._weekdaysRegex;
                }
            } else {
                if (!hasOwnProp(this, '_weekdaysRegex')) {
                    this._weekdaysRegex = defaultWeekdaysRegex;
                }
                return this._weekdaysStrictRegex && isStrict ?
                    this._weekdaysStrictRegex : this._weekdaysRegex;
            }
        }

        var defaultWeekdaysShortRegex = matchWord;
        function weekdaysShortRegex (isStrict) {
            if (this._weekdaysParseExact) {
                if (!hasOwnProp(this, '_weekdaysRegex')) {
                    computeWeekdaysParse.call(this);
                }
                if (isStrict) {
                    return this._weekdaysShortStrictRegex;
                } else {
                    return this._weekdaysShortRegex;
                }
            } else {
                if (!hasOwnProp(this, '_weekdaysShortRegex')) {
                    this._weekdaysShortRegex = defaultWeekdaysShortRegex;
                }
                return this._weekdaysShortStrictRegex && isStrict ?
                    this._weekdaysShortStrictRegex : this._weekdaysShortRegex;
            }
        }

        var defaultWeekdaysMinRegex = matchWord;
        function weekdaysMinRegex (isStrict) {
            if (this._weekdaysParseExact) {
                if (!hasOwnProp(this, '_weekdaysRegex')) {
                    computeWeekdaysParse.call(this);
                }
                if (isStrict) {
                    return this._weekdaysMinStrictRegex;
                } else {
                    return this._weekdaysMinRegex;
                }
            } else {
                if (!hasOwnProp(this, '_weekdaysMinRegex')) {
                    this._weekdaysMinRegex = defaultWeekdaysMinRegex;
                }
                return this._weekdaysMinStrictRegex && isStrict ?
                    this._weekdaysMinStrictRegex : this._weekdaysMinRegex;
            }
        }


        function computeWeekdaysParse () {
            function cmpLenRev(a, b) {
                return b.length - a.length;
            }

            var minPieces = [], shortPieces = [], longPieces = [], mixedPieces = [],
                i, mom, minp, shortp, longp;
            for (i = 0; i < 7; i++) {
                // make the regex if we don't have it already
                mom = createUTC([2000, 1]).day(i);
                minp = this.weekdaysMin(mom, '');
                shortp = this.weekdaysShort(mom, '');
                longp = this.weekdays(mom, '');
                minPieces.push(minp);
                shortPieces.push(shortp);
                longPieces.push(longp);
                mixedPieces.push(minp);
                mixedPieces.push(shortp);
                mixedPieces.push(longp);
            }
            // Sorting makes sure if one weekday (or abbr) is a prefix of another it
            // will match the longer piece.
            minPieces.sort(cmpLenRev);
            shortPieces.sort(cmpLenRev);
            longPieces.sort(cmpLenRev);
            mixedPieces.sort(cmpLenRev);
            for (i = 0; i < 7; i++) {
                shortPieces[i] = regexEscape(shortPieces[i]);
                longPieces[i] = regexEscape(longPieces[i]);
                mixedPieces[i] = regexEscape(mixedPieces[i]);
            }

            this._weekdaysRegex = new RegExp('^(' + mixedPieces.join('|') + ')', 'i');
            this._weekdaysShortRegex = this._weekdaysRegex;
            this._weekdaysMinRegex = this._weekdaysRegex;

            this._weekdaysStrictRegex = new RegExp('^(' + longPieces.join('|') + ')', 'i');
            this._weekdaysShortStrictRegex = new RegExp('^(' + shortPieces.join('|') + ')', 'i');
            this._weekdaysMinStrictRegex = new RegExp('^(' + minPieces.join('|') + ')', 'i');
        }

        // FORMATTING

        function hFormat() {
            return this.hours() % 12 || 12;
        }

        function kFormat() {
            return this.hours() || 24;
        }

        addFormatToken('H', ['HH', 2], 0, 'hour');
        addFormatToken('h', ['hh', 2], 0, hFormat);
        addFormatToken('k', ['kk', 2], 0, kFormat);

        addFormatToken('hmm', 0, 0, function () {
            return '' + hFormat.apply(this) + zeroFill(this.minutes(), 2);
        });

        addFormatToken('hmmss', 0, 0, function () {
            return '' + hFormat.apply(this) + zeroFill(this.minutes(), 2) +
                zeroFill(this.seconds(), 2);
        });

        addFormatToken('Hmm', 0, 0, function () {
            return '' + this.hours() + zeroFill(this.minutes(), 2);
        });

        addFormatToken('Hmmss', 0, 0, function () {
            return '' + this.hours() + zeroFill(this.minutes(), 2) +
                zeroFill(this.seconds(), 2);
        });

        function meridiem (token, lowercase) {
            addFormatToken(token, 0, 0, function () {
                return this.localeData().meridiem(this.hours(), this.minutes(), lowercase);
            });
        }

        meridiem('a', true);
        meridiem('A', false);

        // ALIASES

        addUnitAlias('hour', 'h');

        // PRIORITY
        addUnitPriority('hour', 13);

        // PARSING

        function matchMeridiem (isStrict, locale) {
            return locale._meridiemParse;
        }

        addRegexToken('a',  matchMeridiem);
        addRegexToken('A',  matchMeridiem);
        addRegexToken('H',  match1to2);
        addRegexToken('h',  match1to2);
        addRegexToken('k',  match1to2);
        addRegexToken('HH', match1to2, match2);
        addRegexToken('hh', match1to2, match2);
        addRegexToken('kk', match1to2, match2);

        addRegexToken('hmm', match3to4);
        addRegexToken('hmmss', match5to6);
        addRegexToken('Hmm', match3to4);
        addRegexToken('Hmmss', match5to6);

        addParseToken(['H', 'HH'], HOUR);
        addParseToken(['k', 'kk'], function (input, array, config) {
            var kInput = toInt(input);
            array[HOUR] = kInput === 24 ? 0 : kInput;
        });
        addParseToken(['a', 'A'], function (input, array, config) {
            config._isPm = config._locale.isPM(input);
            config._meridiem = input;
        });
        addParseToken(['h', 'hh'], function (input, array, config) {
            array[HOUR] = toInt(input);
            getParsingFlags(config).bigHour = true;
        });
        addParseToken('hmm', function (input, array, config) {
            var pos = input.length - 2;
            array[HOUR] = toInt(input.substr(0, pos));
            array[MINUTE] = toInt(input.substr(pos));
            getParsingFlags(config).bigHour = true;
        });
        addParseToken('hmmss', function (input, array, config) {
            var pos1 = input.length - 4;
            var pos2 = input.length - 2;
            array[HOUR] = toInt(input.substr(0, pos1));
            array[MINUTE] = toInt(input.substr(pos1, 2));
            array[SECOND] = toInt(input.substr(pos2));
            getParsingFlags(config).bigHour = true;
        });
        addParseToken('Hmm', function (input, array, config) {
            var pos = input.length - 2;
            array[HOUR] = toInt(input.substr(0, pos));
            array[MINUTE] = toInt(input.substr(pos));
        });
        addParseToken('Hmmss', function (input, array, config) {
            var pos1 = input.length - 4;
            var pos2 = input.length - 2;
            array[HOUR] = toInt(input.substr(0, pos1));
            array[MINUTE] = toInt(input.substr(pos1, 2));
            array[SECOND] = toInt(input.substr(pos2));
        });

        // LOCALES

        function localeIsPM (input) {
            // IE8 Quirks Mode & IE7 Standards Mode do not allow accessing strings like arrays
            // Using charAt should be more compatible.
            return ((input + '').toLowerCase().charAt(0) === 'p');
        }

        var defaultLocaleMeridiemParse = /[ap]\.?m?\.?/i;
        function localeMeridiem (hours, minutes, isLower) {
            if (hours > 11) {
                return isLower ? 'pm' : 'PM';
            } else {
                return isLower ? 'am' : 'AM';
            }
        }


        // MOMENTS

        // Setting the hour should keep the time, because the user explicitly
        // specified which hour they want. So trying to maintain the same hour (in
        // a new timezone) makes sense. Adding/subtracting hours does not follow
        // this rule.
        var getSetHour = makeGetSet('Hours', true);

        var baseConfig = {
            calendar: defaultCalendar,
            longDateFormat: defaultLongDateFormat,
            invalidDate: defaultInvalidDate,
            ordinal: defaultOrdinal,
            dayOfMonthOrdinalParse: defaultDayOfMonthOrdinalParse,
            relativeTime: defaultRelativeTime,

            months: defaultLocaleMonths,
            monthsShort: defaultLocaleMonthsShort,

            week: defaultLocaleWeek,

            weekdays: defaultLocaleWeekdays,
            weekdaysMin: defaultLocaleWeekdaysMin,
            weekdaysShort: defaultLocaleWeekdaysShort,

            meridiemParse: defaultLocaleMeridiemParse
        };

        // internal storage for locale config files
        var locales = {};
        var localeFamilies = {};
        var globalLocale;

        function normalizeLocale(key) {
            return key ? key.toLowerCase().replace('_', '-') : key;
        }

        // pick the locale from the array
        // try ['en-au', 'en-gb'] as 'en-au', 'en-gb', 'en', as in move through the list trying each
        // substring from most specific to least, but move to the next array item if it's a more specific variant than the current root
        function chooseLocale(names) {
            var i = 0, j, next, locale, split;

            while (i < names.length) {
                split = normalizeLocale(names[i]).split('-');
                j = split.length;
                next = normalizeLocale(names[i + 1]);
                next = next ? next.split('-') : null;
                while (j > 0) {
                    locale = loadLocale(split.slice(0, j).join('-'));
                    if (locale) {
                        return locale;
                    }
                    if (next && next.length >= j && compareArrays(split, next, true) >= j - 1) {
                        //the next array item is better than a shallower substring of this one
                        break;
                    }
                    j--;
                }
                i++;
            }
            return globalLocale;
        }

        function loadLocale(name) {
            var oldLocale = null;
            // TODO: Find a better way to register and load all the locales in Node
            if (!locales[name] && ('object' !== 'undefined') &&
                    module && module.exports) {
                try {
                    oldLocale = globalLocale._abbr;
                    var aliasedRequire = commonjsRequire;
                    aliasedRequire('./locale/' + name);
                    getSetGlobalLocale(oldLocale);
                } catch (e) {}
            }
            return locales[name];
        }

        // This function will load locale and then set the global locale.  If
        // no arguments are passed in, it will simply return the current global
        // locale key.
        function getSetGlobalLocale (key, values) {
            var data;
            if (key) {
                if (isUndefined(values)) {
                    data = getLocale(key);
                }
                else {
                    data = defineLocale(key, values);
                }

                if (data) {
                    // moment.duration._locale = moment._locale = data;
                    globalLocale = data;
                }
                else {
                    if ((typeof console !==  'undefined') && console.warn) {
                        //warn user if arguments are passed but the locale could not be set
                        console.warn('Locale ' + key +  ' not found. Did you forget to load it?');
                    }
                }
            }

            return globalLocale._abbr;
        }

        function defineLocale (name, config) {
            if (config !== null) {
                var locale, parentConfig = baseConfig;
                config.abbr = name;
                if (locales[name] != null) {
                    deprecateSimple('defineLocaleOverride',
                            'use moment.updateLocale(localeName, config) to change ' +
                            'an existing locale. moment.defineLocale(localeName, ' +
                            'config) should only be used for creating a new locale ' +
                            'See http://momentjs.com/guides/#/warnings/define-locale/ for more info.');
                    parentConfig = locales[name]._config;
                } else if (config.parentLocale != null) {
                    if (locales[config.parentLocale] != null) {
                        parentConfig = locales[config.parentLocale]._config;
                    } else {
                        locale = loadLocale(config.parentLocale);
                        if (locale != null) {
                            parentConfig = locale._config;
                        } else {
                            if (!localeFamilies[config.parentLocale]) {
                                localeFamilies[config.parentLocale] = [];
                            }
                            localeFamilies[config.parentLocale].push({
                                name: name,
                                config: config
                            });
                            return null;
                        }
                    }
                }
                locales[name] = new Locale(mergeConfigs(parentConfig, config));

                if (localeFamilies[name]) {
                    localeFamilies[name].forEach(function (x) {
                        defineLocale(x.name, x.config);
                    });
                }

                // backwards compat for now: also set the locale
                // make sure we set the locale AFTER all child locales have been
                // created, so we won't end up with the child locale set.
                getSetGlobalLocale(name);


                return locales[name];
            } else {
                // useful for testing
                delete locales[name];
                return null;
            }
        }

        function updateLocale(name, config) {
            if (config != null) {
                var locale, tmpLocale, parentConfig = baseConfig;
                // MERGE
                tmpLocale = loadLocale(name);
                if (tmpLocale != null) {
                    parentConfig = tmpLocale._config;
                }
                config = mergeConfigs(parentConfig, config);
                locale = new Locale(config);
                locale.parentLocale = locales[name];
                locales[name] = locale;

                // backwards compat for now: also set the locale
                getSetGlobalLocale(name);
            } else {
                // pass null for config to unupdate, useful for tests
                if (locales[name] != null) {
                    if (locales[name].parentLocale != null) {
                        locales[name] = locales[name].parentLocale;
                    } else if (locales[name] != null) {
                        delete locales[name];
                    }
                }
            }
            return locales[name];
        }

        // returns locale data
        function getLocale (key) {
            var locale;

            if (key && key._locale && key._locale._abbr) {
                key = key._locale._abbr;
            }

            if (!key) {
                return globalLocale;
            }

            if (!isArray(key)) {
                //short-circuit everything else
                locale = loadLocale(key);
                if (locale) {
                    return locale;
                }
                key = [key];
            }

            return chooseLocale(key);
        }

        function listLocales() {
            return keys(locales);
        }

        function checkOverflow (m) {
            var overflow;
            var a = m._a;

            if (a && getParsingFlags(m).overflow === -2) {
                overflow =
                    a[MONTH]       < 0 || a[MONTH]       > 11  ? MONTH :
                    a[DATE]        < 1 || a[DATE]        > daysInMonth(a[YEAR], a[MONTH]) ? DATE :
                    a[HOUR]        < 0 || a[HOUR]        > 24 || (a[HOUR] === 24 && (a[MINUTE] !== 0 || a[SECOND] !== 0 || a[MILLISECOND] !== 0)) ? HOUR :
                    a[MINUTE]      < 0 || a[MINUTE]      > 59  ? MINUTE :
                    a[SECOND]      < 0 || a[SECOND]      > 59  ? SECOND :
                    a[MILLISECOND] < 0 || a[MILLISECOND] > 999 ? MILLISECOND :
                    -1;

                if (getParsingFlags(m)._overflowDayOfYear && (overflow < YEAR || overflow > DATE)) {
                    overflow = DATE;
                }
                if (getParsingFlags(m)._overflowWeeks && overflow === -1) {
                    overflow = WEEK;
                }
                if (getParsingFlags(m)._overflowWeekday && overflow === -1) {
                    overflow = WEEKDAY;
                }

                getParsingFlags(m).overflow = overflow;
            }

            return m;
        }

        // Pick the first defined of two or three arguments.
        function defaults(a, b, c) {
            if (a != null) {
                return a;
            }
            if (b != null) {
                return b;
            }
            return c;
        }

        function currentDateArray(config) {
            // hooks is actually the exported moment object
            var nowValue = new Date(hooks.now());
            if (config._useUTC) {
                return [nowValue.getUTCFullYear(), nowValue.getUTCMonth(), nowValue.getUTCDate()];
            }
            return [nowValue.getFullYear(), nowValue.getMonth(), nowValue.getDate()];
        }

        // convert an array to a date.
        // the array should mirror the parameters below
        // note: all values past the year are optional and will default to the lowest possible value.
        // [year, month, day , hour, minute, second, millisecond]
        function configFromArray (config) {
            var i, date, input = [], currentDate, expectedWeekday, yearToUse;

            if (config._d) {
                return;
            }

            currentDate = currentDateArray(config);

            //compute day of the year from weeks and weekdays
            if (config._w && config._a[DATE] == null && config._a[MONTH] == null) {
                dayOfYearFromWeekInfo(config);
            }

            //if the day of the year is set, figure out what it is
            if (config._dayOfYear != null) {
                yearToUse = defaults(config._a[YEAR], currentDate[YEAR]);

                if (config._dayOfYear > daysInYear(yearToUse) || config._dayOfYear === 0) {
                    getParsingFlags(config)._overflowDayOfYear = true;
                }

                date = createUTCDate(yearToUse, 0, config._dayOfYear);
                config._a[MONTH] = date.getUTCMonth();
                config._a[DATE] = date.getUTCDate();
            }

            // Default to current date.
            // * if no year, month, day of month are given, default to today
            // * if day of month is given, default month and year
            // * if month is given, default only year
            // * if year is given, don't default anything
            for (i = 0; i < 3 && config._a[i] == null; ++i) {
                config._a[i] = input[i] = currentDate[i];
            }

            // Zero out whatever was not defaulted, including time
            for (; i < 7; i++) {
                config._a[i] = input[i] = (config._a[i] == null) ? (i === 2 ? 1 : 0) : config._a[i];
            }

            // Check for 24:00:00.000
            if (config._a[HOUR] === 24 &&
                    config._a[MINUTE] === 0 &&
                    config._a[SECOND] === 0 &&
                    config._a[MILLISECOND] === 0) {
                config._nextDay = true;
                config._a[HOUR] = 0;
            }

            config._d = (config._useUTC ? createUTCDate : createDate).apply(null, input);
            expectedWeekday = config._useUTC ? config._d.getUTCDay() : config._d.getDay();

            // Apply timezone offset from input. The actual utcOffset can be changed
            // with parseZone.
            if (config._tzm != null) {
                config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);
            }

            if (config._nextDay) {
                config._a[HOUR] = 24;
            }

            // check for mismatching day of week
            if (config._w && typeof config._w.d !== 'undefined' && config._w.d !== expectedWeekday) {
                getParsingFlags(config).weekdayMismatch = true;
            }
        }

        function dayOfYearFromWeekInfo(config) {
            var w, weekYear, week, weekday, dow, doy, temp, weekdayOverflow;

            w = config._w;
            if (w.GG != null || w.W != null || w.E != null) {
                dow = 1;
                doy = 4;

                // TODO: We need to take the current isoWeekYear, but that depends on
                // how we interpret now (local, utc, fixed offset). So create
                // a now version of current config (take local/utc/offset flags, and
                // create now).
                weekYear = defaults(w.GG, config._a[YEAR], weekOfYear(createLocal(), 1, 4).year);
                week = defaults(w.W, 1);
                weekday = defaults(w.E, 1);
                if (weekday < 1 || weekday > 7) {
                    weekdayOverflow = true;
                }
            } else {
                dow = config._locale._week.dow;
                doy = config._locale._week.doy;

                var curWeek = weekOfYear(createLocal(), dow, doy);

                weekYear = defaults(w.gg, config._a[YEAR], curWeek.year);

                // Default to current week.
                week = defaults(w.w, curWeek.week);

                if (w.d != null) {
                    // weekday -- low day numbers are considered next week
                    weekday = w.d;
                    if (weekday < 0 || weekday > 6) {
                        weekdayOverflow = true;
                    }
                } else if (w.e != null) {
                    // local weekday -- counting starts from begining of week
                    weekday = w.e + dow;
                    if (w.e < 0 || w.e > 6) {
                        weekdayOverflow = true;
                    }
                } else {
                    // default to begining of week
                    weekday = dow;
                }
            }
            if (week < 1 || week > weeksInYear(weekYear, dow, doy)) {
                getParsingFlags(config)._overflowWeeks = true;
            } else if (weekdayOverflow != null) {
                getParsingFlags(config)._overflowWeekday = true;
            } else {
                temp = dayOfYearFromWeeks(weekYear, week, weekday, dow, doy);
                config._a[YEAR] = temp.year;
                config._dayOfYear = temp.dayOfYear;
            }
        }

        // iso 8601 regex
        // 0000-00-00 0000-W00 or 0000-W00-0 + T + 00 or 00:00 or 00:00:00 or 00:00:00.000 + +00:00 or +0000 or +00)
        var extendedIsoRegex = /^\s*((?:[+-]\d{6}|\d{4})-(?:\d\d-\d\d|W\d\d-\d|W\d\d|\d\d\d|\d\d))(?:(T| )(\d\d(?::\d\d(?::\d\d(?:[.,]\d+)?)?)?)([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/;
        var basicIsoRegex = /^\s*((?:[+-]\d{6}|\d{4})(?:\d\d\d\d|W\d\d\d|W\d\d|\d\d\d|\d\d))(?:(T| )(\d\d(?:\d\d(?:\d\d(?:[.,]\d+)?)?)?)([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/;

        var tzRegex = /Z|[+-]\d\d(?::?\d\d)?/;

        var isoDates = [
            ['YYYYYY-MM-DD', /[+-]\d{6}-\d\d-\d\d/],
            ['YYYY-MM-DD', /\d{4}-\d\d-\d\d/],
            ['GGGG-[W]WW-E', /\d{4}-W\d\d-\d/],
            ['GGGG-[W]WW', /\d{4}-W\d\d/, false],
            ['YYYY-DDD', /\d{4}-\d{3}/],
            ['YYYY-MM', /\d{4}-\d\d/, false],
            ['YYYYYYMMDD', /[+-]\d{10}/],
            ['YYYYMMDD', /\d{8}/],
            // YYYYMM is NOT allowed by the standard
            ['GGGG[W]WWE', /\d{4}W\d{3}/],
            ['GGGG[W]WW', /\d{4}W\d{2}/, false],
            ['YYYYDDD', /\d{7}/]
        ];

        // iso time formats and regexes
        var isoTimes = [
            ['HH:mm:ss.SSSS', /\d\d:\d\d:\d\d\.\d+/],
            ['HH:mm:ss,SSSS', /\d\d:\d\d:\d\d,\d+/],
            ['HH:mm:ss', /\d\d:\d\d:\d\d/],
            ['HH:mm', /\d\d:\d\d/],
            ['HHmmss.SSSS', /\d\d\d\d\d\d\.\d+/],
            ['HHmmss,SSSS', /\d\d\d\d\d\d,\d+/],
            ['HHmmss', /\d\d\d\d\d\d/],
            ['HHmm', /\d\d\d\d/],
            ['HH', /\d\d/]
        ];

        var aspNetJsonRegex = /^\/?Date\((\-?\d+)/i;

        // date from iso format
        function configFromISO(config) {
            var i, l,
                string = config._i,
                match = extendedIsoRegex.exec(string) || basicIsoRegex.exec(string),
                allowTime, dateFormat, timeFormat, tzFormat;

            if (match) {
                getParsingFlags(config).iso = true;

                for (i = 0, l = isoDates.length; i < l; i++) {
                    if (isoDates[i][1].exec(match[1])) {
                        dateFormat = isoDates[i][0];
                        allowTime = isoDates[i][2] !== false;
                        break;
                    }
                }
                if (dateFormat == null) {
                    config._isValid = false;
                    return;
                }
                if (match[3]) {
                    for (i = 0, l = isoTimes.length; i < l; i++) {
                        if (isoTimes[i][1].exec(match[3])) {
                            // match[2] should be 'T' or space
                            timeFormat = (match[2] || ' ') + isoTimes[i][0];
                            break;
                        }
                    }
                    if (timeFormat == null) {
                        config._isValid = false;
                        return;
                    }
                }
                if (!allowTime && timeFormat != null) {
                    config._isValid = false;
                    return;
                }
                if (match[4]) {
                    if (tzRegex.exec(match[4])) {
                        tzFormat = 'Z';
                    } else {
                        config._isValid = false;
                        return;
                    }
                }
                config._f = dateFormat + (timeFormat || '') + (tzFormat || '');
                configFromStringAndFormat(config);
            } else {
                config._isValid = false;
            }
        }

        // RFC 2822 regex: For details see https://tools.ietf.org/html/rfc2822#section-3.3
        var rfc2822 = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s)?(\d{1,2})\s(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s(\d{2,4})\s(\d\d):(\d\d)(?::(\d\d))?\s(?:(UT|GMT|[ECMP][SD]T)|([Zz])|([+-]\d{4}))$/;

        function extractFromRFC2822Strings(yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr) {
            var result = [
                untruncateYear(yearStr),
                defaultLocaleMonthsShort.indexOf(monthStr),
                parseInt(dayStr, 10),
                parseInt(hourStr, 10),
                parseInt(minuteStr, 10)
            ];

            if (secondStr) {
                result.push(parseInt(secondStr, 10));
            }

            return result;
        }

        function untruncateYear(yearStr) {
            var year = parseInt(yearStr, 10);
            if (year <= 49) {
                return 2000 + year;
            } else if (year <= 999) {
                return 1900 + year;
            }
            return year;
        }

        function preprocessRFC2822(s) {
            // Remove comments and folding whitespace and replace multiple-spaces with a single space
            return s.replace(/\([^)]*\)|[\n\t]/g, ' ').replace(/(\s\s+)/g, ' ').trim();
        }

        function checkWeekday(weekdayStr, parsedInput, config) {
            if (weekdayStr) {
                // TODO: Replace the vanilla JS Date object with an indepentent day-of-week check.
                var weekdayProvided = defaultLocaleWeekdaysShort.indexOf(weekdayStr),
                    weekdayActual = new Date(parsedInput[0], parsedInput[1], parsedInput[2]).getDay();
                if (weekdayProvided !== weekdayActual) {
                    getParsingFlags(config).weekdayMismatch = true;
                    config._isValid = false;
                    return false;
                }
            }
            return true;
        }

        var obsOffsets = {
            UT: 0,
            GMT: 0,
            EDT: -4 * 60,
            EST: -5 * 60,
            CDT: -5 * 60,
            CST: -6 * 60,
            MDT: -6 * 60,
            MST: -7 * 60,
            PDT: -7 * 60,
            PST: -8 * 60
        };

        function calculateOffset(obsOffset, militaryOffset, numOffset) {
            if (obsOffset) {
                return obsOffsets[obsOffset];
            } else if (militaryOffset) {
                // the only allowed military tz is Z
                return 0;
            } else {
                var hm = parseInt(numOffset, 10);
                var m = hm % 100, h = (hm - m) / 100;
                return h * 60 + m;
            }
        }

        // date and time from ref 2822 format
        function configFromRFC2822(config) {
            var match = rfc2822.exec(preprocessRFC2822(config._i));
            if (match) {
                var parsedArray = extractFromRFC2822Strings(match[4], match[3], match[2], match[5], match[6], match[7]);
                if (!checkWeekday(match[1], parsedArray, config)) {
                    return;
                }

                config._a = parsedArray;
                config._tzm = calculateOffset(match[8], match[9], match[10]);

                config._d = createUTCDate.apply(null, config._a);
                config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);

                getParsingFlags(config).rfc2822 = true;
            } else {
                config._isValid = false;
            }
        }

        // date from iso format or fallback
        function configFromString(config) {
            var matched = aspNetJsonRegex.exec(config._i);

            if (matched !== null) {
                config._d = new Date(+matched[1]);
                return;
            }

            configFromISO(config);
            if (config._isValid === false) {
                delete config._isValid;
            } else {
                return;
            }

            configFromRFC2822(config);
            if (config._isValid === false) {
                delete config._isValid;
            } else {
                return;
            }

            // Final attempt, use Input Fallback
            hooks.createFromInputFallback(config);
        }

        hooks.createFromInputFallback = deprecate(
            'value provided is not in a recognized RFC2822 or ISO format. moment construction falls back to js Date(), ' +
            'which is not reliable across all browsers and versions. Non RFC2822/ISO date formats are ' +
            'discouraged and will be removed in an upcoming major release. Please refer to ' +
            'http://momentjs.com/guides/#/warnings/js-date/ for more info.',
            function (config) {
                config._d = new Date(config._i + (config._useUTC ? ' UTC' : ''));
            }
        );

        // constant that refers to the ISO standard
        hooks.ISO_8601 = function () {};

        // constant that refers to the RFC 2822 form
        hooks.RFC_2822 = function () {};

        // date from string and format string
        function configFromStringAndFormat(config) {
            // TODO: Move this to another part of the creation flow to prevent circular deps
            if (config._f === hooks.ISO_8601) {
                configFromISO(config);
                return;
            }
            if (config._f === hooks.RFC_2822) {
                configFromRFC2822(config);
                return;
            }
            config._a = [];
            getParsingFlags(config).empty = true;

            // This array is used to make a Date, either with `new Date` or `Date.UTC`
            var string = '' + config._i,
                i, parsedInput, tokens, token, skipped,
                stringLength = string.length,
                totalParsedInputLength = 0;

            tokens = expandFormat(config._f, config._locale).match(formattingTokens) || [];

            for (i = 0; i < tokens.length; i++) {
                token = tokens[i];
                parsedInput = (string.match(getParseRegexForToken(token, config)) || [])[0];
                // console.log('token', token, 'parsedInput', parsedInput,
                //         'regex', getParseRegexForToken(token, config));
                if (parsedInput) {
                    skipped = string.substr(0, string.indexOf(parsedInput));
                    if (skipped.length > 0) {
                        getParsingFlags(config).unusedInput.push(skipped);
                    }
                    string = string.slice(string.indexOf(parsedInput) + parsedInput.length);
                    totalParsedInputLength += parsedInput.length;
                }
                // don't parse if it's not a known token
                if (formatTokenFunctions[token]) {
                    if (parsedInput) {
                        getParsingFlags(config).empty = false;
                    }
                    else {
                        getParsingFlags(config).unusedTokens.push(token);
                    }
                    addTimeToArrayFromToken(token, parsedInput, config);
                }
                else if (config._strict && !parsedInput) {
                    getParsingFlags(config).unusedTokens.push(token);
                }
            }

            // add remaining unparsed input length to the string
            getParsingFlags(config).charsLeftOver = stringLength - totalParsedInputLength;
            if (string.length > 0) {
                getParsingFlags(config).unusedInput.push(string);
            }

            // clear _12h flag if hour is <= 12
            if (config._a[HOUR] <= 12 &&
                getParsingFlags(config).bigHour === true &&
                config._a[HOUR] > 0) {
                getParsingFlags(config).bigHour = undefined;
            }

            getParsingFlags(config).parsedDateParts = config._a.slice(0);
            getParsingFlags(config).meridiem = config._meridiem;
            // handle meridiem
            config._a[HOUR] = meridiemFixWrap(config._locale, config._a[HOUR], config._meridiem);

            configFromArray(config);
            checkOverflow(config);
        }


        function meridiemFixWrap (locale, hour, meridiem) {
            var isPm;

            if (meridiem == null) {
                // nothing to do
                return hour;
            }
            if (locale.meridiemHour != null) {
                return locale.meridiemHour(hour, meridiem);
            } else if (locale.isPM != null) {
                // Fallback
                isPm = locale.isPM(meridiem);
                if (isPm && hour < 12) {
                    hour += 12;
                }
                if (!isPm && hour === 12) {
                    hour = 0;
                }
                return hour;
            } else {
                // this is not supposed to happen
                return hour;
            }
        }

        // date from string and array of format strings
        function configFromStringAndArray(config) {
            var tempConfig,
                bestMoment,

                scoreToBeat,
                i,
                currentScore;

            if (config._f.length === 0) {
                getParsingFlags(config).invalidFormat = true;
                config._d = new Date(NaN);
                return;
            }

            for (i = 0; i < config._f.length; i++) {
                currentScore = 0;
                tempConfig = copyConfig({}, config);
                if (config._useUTC != null) {
                    tempConfig._useUTC = config._useUTC;
                }
                tempConfig._f = config._f[i];
                configFromStringAndFormat(tempConfig);

                if (!isValid(tempConfig)) {
                    continue;
                }

                // if there is any input that was not parsed add a penalty for that format
                currentScore += getParsingFlags(tempConfig).charsLeftOver;

                //or tokens
                currentScore += getParsingFlags(tempConfig).unusedTokens.length * 10;

                getParsingFlags(tempConfig).score = currentScore;

                if (scoreToBeat == null || currentScore < scoreToBeat) {
                    scoreToBeat = currentScore;
                    bestMoment = tempConfig;
                }
            }

            extend(config, bestMoment || tempConfig);
        }

        function configFromObject(config) {
            if (config._d) {
                return;
            }

            var i = normalizeObjectUnits(config._i);
            config._a = map([i.year, i.month, i.day || i.date, i.hour, i.minute, i.second, i.millisecond], function (obj) {
                return obj && parseInt(obj, 10);
            });

            configFromArray(config);
        }

        function createFromConfig (config) {
            var res = new Moment(checkOverflow(prepareConfig(config)));
            if (res._nextDay) {
                // Adding is smart enough around DST
                res.add(1, 'd');
                res._nextDay = undefined;
            }

            return res;
        }

        function prepareConfig (config) {
            var input = config._i,
                format = config._f;

            config._locale = config._locale || getLocale(config._l);

            if (input === null || (format === undefined && input === '')) {
                return createInvalid({nullInput: true});
            }

            if (typeof input === 'string') {
                config._i = input = config._locale.preparse(input);
            }

            if (isMoment(input)) {
                return new Moment(checkOverflow(input));
            } else if (isDate(input)) {
                config._d = input;
            } else if (isArray(format)) {
                configFromStringAndArray(config);
            } else if (format) {
                configFromStringAndFormat(config);
            }  else {
                configFromInput(config);
            }

            if (!isValid(config)) {
                config._d = null;
            }

            return config;
        }

        function configFromInput(config) {
            var input = config._i;
            if (isUndefined(input)) {
                config._d = new Date(hooks.now());
            } else if (isDate(input)) {
                config._d = new Date(input.valueOf());
            } else if (typeof input === 'string') {
                configFromString(config);
            } else if (isArray(input)) {
                config._a = map(input.slice(0), function (obj) {
                    return parseInt(obj, 10);
                });
                configFromArray(config);
            } else if (isObject(input)) {
                configFromObject(config);
            } else if (isNumber(input)) {
                // from milliseconds
                config._d = new Date(input);
            } else {
                hooks.createFromInputFallback(config);
            }
        }

        function createLocalOrUTC (input, format, locale, strict, isUTC) {
            var c = {};

            if (locale === true || locale === false) {
                strict = locale;
                locale = undefined;
            }

            if ((isObject(input) && isObjectEmpty(input)) ||
                    (isArray(input) && input.length === 0)) {
                input = undefined;
            }
            // object construction must be done this way.
            // https://github.com/moment/moment/issues/1423
            c._isAMomentObject = true;
            c._useUTC = c._isUTC = isUTC;
            c._l = locale;
            c._i = input;
            c._f = format;
            c._strict = strict;

            return createFromConfig(c);
        }

        function createLocal (input, format, locale, strict) {
            return createLocalOrUTC(input, format, locale, strict, false);
        }

        var prototypeMin = deprecate(
            'moment().min is deprecated, use moment.max instead. http://momentjs.com/guides/#/warnings/min-max/',
            function () {
                var other = createLocal.apply(null, arguments);
                if (this.isValid() && other.isValid()) {
                    return other < this ? this : other;
                } else {
                    return createInvalid();
                }
            }
        );

        var prototypeMax = deprecate(
            'moment().max is deprecated, use moment.min instead. http://momentjs.com/guides/#/warnings/min-max/',
            function () {
                var other = createLocal.apply(null, arguments);
                if (this.isValid() && other.isValid()) {
                    return other > this ? this : other;
                } else {
                    return createInvalid();
                }
            }
        );

        // Pick a moment m from moments so that m[fn](other) is true for all
        // other. This relies on the function fn to be transitive.
        //
        // moments should either be an array of moment objects or an array, whose
        // first element is an array of moment objects.
        function pickBy(fn, moments) {
            var res, i;
            if (moments.length === 1 && isArray(moments[0])) {
                moments = moments[0];
            }
            if (!moments.length) {
                return createLocal();
            }
            res = moments[0];
            for (i = 1; i < moments.length; ++i) {
                if (!moments[i].isValid() || moments[i][fn](res)) {
                    res = moments[i];
                }
            }
            return res;
        }

        // TODO: Use [].sort instead?
        function min () {
            var args = [].slice.call(arguments, 0);

            return pickBy('isBefore', args);
        }

        function max () {
            var args = [].slice.call(arguments, 0);

            return pickBy('isAfter', args);
        }

        var now = function () {
            return Date.now ? Date.now() : +(new Date());
        };

        var ordering = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'];

        function isDurationValid(m) {
            for (var key in m) {
                if (!(indexOf.call(ordering, key) !== -1 && (m[key] == null || !isNaN(m[key])))) {
                    return false;
                }
            }

            var unitHasDecimal = false;
            for (var i = 0; i < ordering.length; ++i) {
                if (m[ordering[i]]) {
                    if (unitHasDecimal) {
                        return false; // only allow non-integers for smallest unit
                    }
                    if (parseFloat(m[ordering[i]]) !== toInt(m[ordering[i]])) {
                        unitHasDecimal = true;
                    }
                }
            }

            return true;
        }

        function isValid$1() {
            return this._isValid;
        }

        function createInvalid$1() {
            return createDuration(NaN);
        }

        function Duration (duration) {
            var normalizedInput = normalizeObjectUnits(duration),
                years = normalizedInput.year || 0,
                quarters = normalizedInput.quarter || 0,
                months = normalizedInput.month || 0,
                weeks = normalizedInput.week || 0,
                days = normalizedInput.day || 0,
                hours = normalizedInput.hour || 0,
                minutes = normalizedInput.minute || 0,
                seconds = normalizedInput.second || 0,
                milliseconds = normalizedInput.millisecond || 0;

            this._isValid = isDurationValid(normalizedInput);

            // representation for dateAddRemove
            this._milliseconds = +milliseconds +
                seconds * 1e3 + // 1000
                minutes * 6e4 + // 1000 * 60
                hours * 1000 * 60 * 60; //using 1000 * 60 * 60 instead of 36e5 to avoid floating point rounding errors https://github.com/moment/moment/issues/2978
            // Because of dateAddRemove treats 24 hours as different from a
            // day when working around DST, we need to store them separately
            this._days = +days +
                weeks * 7;
            // It is impossible to translate months into days without knowing
            // which months you are are talking about, so we have to store
            // it separately.
            this._months = +months +
                quarters * 3 +
                years * 12;

            this._data = {};

            this._locale = getLocale();

            this._bubble();
        }

        function isDuration (obj) {
            return obj instanceof Duration;
        }

        function absRound (number) {
            if (number < 0) {
                return Math.round(-1 * number) * -1;
            } else {
                return Math.round(number);
            }
        }

        // FORMATTING

        function offset (token, separator) {
            addFormatToken(token, 0, 0, function () {
                var offset = this.utcOffset();
                var sign = '+';
                if (offset < 0) {
                    offset = -offset;
                    sign = '-';
                }
                return sign + zeroFill(~~(offset / 60), 2) + separator + zeroFill(~~(offset) % 60, 2);
            });
        }

        offset('Z', ':');
        offset('ZZ', '');

        // PARSING

        addRegexToken('Z',  matchShortOffset);
        addRegexToken('ZZ', matchShortOffset);
        addParseToken(['Z', 'ZZ'], function (input, array, config) {
            config._useUTC = true;
            config._tzm = offsetFromString(matchShortOffset, input);
        });

        // HELPERS

        // timezone chunker
        // '+10:00' > ['10',  '00']
        // '-1530'  > ['-15', '30']
        var chunkOffset = /([\+\-]|\d\d)/gi;

        function offsetFromString(matcher, string) {
            var matches = (string || '').match(matcher);

            if (matches === null) {
                return null;
            }

            var chunk   = matches[matches.length - 1] || [];
            var parts   = (chunk + '').match(chunkOffset) || ['-', 0, 0];
            var minutes = +(parts[1] * 60) + toInt(parts[2]);

            return minutes === 0 ?
              0 :
              parts[0] === '+' ? minutes : -minutes;
        }

        // Return a moment from input, that is local/utc/zone equivalent to model.
        function cloneWithOffset(input, model) {
            var res, diff;
            if (model._isUTC) {
                res = model.clone();
                diff = (isMoment(input) || isDate(input) ? input.valueOf() : createLocal(input).valueOf()) - res.valueOf();
                // Use low-level api, because this fn is low-level api.
                res._d.setTime(res._d.valueOf() + diff);
                hooks.updateOffset(res, false);
                return res;
            } else {
                return createLocal(input).local();
            }
        }

        function getDateOffset (m) {
            // On Firefox.24 Date#getTimezoneOffset returns a floating point.
            // https://github.com/moment/moment/pull/1871
            return -Math.round(m._d.getTimezoneOffset() / 15) * 15;
        }

        // HOOKS

        // This function will be called whenever a moment is mutated.
        // It is intended to keep the offset in sync with the timezone.
        hooks.updateOffset = function () {};

        // MOMENTS

        // keepLocalTime = true means only change the timezone, without
        // affecting the local hour. So 5:31:26 +0300 --[utcOffset(2, true)]-->
        // 5:31:26 +0200 It is possible that 5:31:26 doesn't exist with offset
        // +0200, so we adjust the time as needed, to be valid.
        //
        // Keeping the time actually adds/subtracts (one hour)
        // from the actual represented time. That is why we call updateOffset
        // a second time. In case it wants us to change the offset again
        // _changeInProgress == true case, then we have to adjust, because
        // there is no such time in the given timezone.
        function getSetOffset (input, keepLocalTime, keepMinutes) {
            var offset = this._offset || 0,
                localAdjust;
            if (!this.isValid()) {
                return input != null ? this : NaN;
            }
            if (input != null) {
                if (typeof input === 'string') {
                    input = offsetFromString(matchShortOffset, input);
                    if (input === null) {
                        return this;
                    }
                } else if (Math.abs(input) < 16 && !keepMinutes) {
                    input = input * 60;
                }
                if (!this._isUTC && keepLocalTime) {
                    localAdjust = getDateOffset(this);
                }
                this._offset = input;
                this._isUTC = true;
                if (localAdjust != null) {
                    this.add(localAdjust, 'm');
                }
                if (offset !== input) {
                    if (!keepLocalTime || this._changeInProgress) {
                        addSubtract(this, createDuration(input - offset, 'm'), 1, false);
                    } else if (!this._changeInProgress) {
                        this._changeInProgress = true;
                        hooks.updateOffset(this, true);
                        this._changeInProgress = null;
                    }
                }
                return this;
            } else {
                return this._isUTC ? offset : getDateOffset(this);
            }
        }

        function getSetZone (input, keepLocalTime) {
            if (input != null) {
                if (typeof input !== 'string') {
                    input = -input;
                }

                this.utcOffset(input, keepLocalTime);

                return this;
            } else {
                return -this.utcOffset();
            }
        }

        function setOffsetToUTC (keepLocalTime) {
            return this.utcOffset(0, keepLocalTime);
        }

        function setOffsetToLocal (keepLocalTime) {
            if (this._isUTC) {
                this.utcOffset(0, keepLocalTime);
                this._isUTC = false;

                if (keepLocalTime) {
                    this.subtract(getDateOffset(this), 'm');
                }
            }
            return this;
        }

        function setOffsetToParsedOffset () {
            if (this._tzm != null) {
                this.utcOffset(this._tzm, false, true);
            } else if (typeof this._i === 'string') {
                var tZone = offsetFromString(matchOffset, this._i);
                if (tZone != null) {
                    this.utcOffset(tZone);
                }
                else {
                    this.utcOffset(0, true);
                }
            }
            return this;
        }

        function hasAlignedHourOffset (input) {
            if (!this.isValid()) {
                return false;
            }
            input = input ? createLocal(input).utcOffset() : 0;

            return (this.utcOffset() - input) % 60 === 0;
        }

        function isDaylightSavingTime () {
            return (
                this.utcOffset() > this.clone().month(0).utcOffset() ||
                this.utcOffset() > this.clone().month(5).utcOffset()
            );
        }

        function isDaylightSavingTimeShifted () {
            if (!isUndefined(this._isDSTShifted)) {
                return this._isDSTShifted;
            }

            var c = {};

            copyConfig(c, this);
            c = prepareConfig(c);

            if (c._a) {
                var other = c._isUTC ? createUTC(c._a) : createLocal(c._a);
                this._isDSTShifted = this.isValid() &&
                    compareArrays(c._a, other.toArray()) > 0;
            } else {
                this._isDSTShifted = false;
            }

            return this._isDSTShifted;
        }

        function isLocal () {
            return this.isValid() ? !this._isUTC : false;
        }

        function isUtcOffset () {
            return this.isValid() ? this._isUTC : false;
        }

        function isUtc () {
            return this.isValid() ? this._isUTC && this._offset === 0 : false;
        }

        // ASP.NET json date format regex
        var aspNetRegex = /^(\-|\+)?(?:(\d*)[. ])?(\d+)\:(\d+)(?:\:(\d+)(\.\d*)?)?$/;

        // from http://docs.closure-library.googlecode.com/git/closure_goog_date_date.js.source.html
        // somewhat more in line with 4.4.3.2 2004 spec, but allows decimal anywhere
        // and further modified to allow for strings containing both week and day
        var isoRegex = /^(-|\+)?P(?:([-+]?[0-9,.]*)Y)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)W)?(?:([-+]?[0-9,.]*)D)?(?:T(?:([-+]?[0-9,.]*)H)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)S)?)?$/;

        function createDuration (input, key) {
            var duration = input,
                // matching against regexp is expensive, do it on demand
                match = null,
                sign,
                ret,
                diffRes;

            if (isDuration(input)) {
                duration = {
                    ms : input._milliseconds,
                    d  : input._days,
                    M  : input._months
                };
            } else if (isNumber(input)) {
                duration = {};
                if (key) {
                    duration[key] = input;
                } else {
                    duration.milliseconds = input;
                }
            } else if (!!(match = aspNetRegex.exec(input))) {
                sign = (match[1] === '-') ? -1 : 1;
                duration = {
                    y  : 0,
                    d  : toInt(match[DATE])                         * sign,
                    h  : toInt(match[HOUR])                         * sign,
                    m  : toInt(match[MINUTE])                       * sign,
                    s  : toInt(match[SECOND])                       * sign,
                    ms : toInt(absRound(match[MILLISECOND] * 1000)) * sign // the millisecond decimal point is included in the match
                };
            } else if (!!(match = isoRegex.exec(input))) {
                sign = (match[1] === '-') ? -1 : (match[1] === '+') ? 1 : 1;
                duration = {
                    y : parseIso(match[2], sign),
                    M : parseIso(match[3], sign),
                    w : parseIso(match[4], sign),
                    d : parseIso(match[5], sign),
                    h : parseIso(match[6], sign),
                    m : parseIso(match[7], sign),
                    s : parseIso(match[8], sign)
                };
            } else if (duration == null) {// checks for null or undefined
                duration = {};
            } else if (typeof duration === 'object' && ('from' in duration || 'to' in duration)) {
                diffRes = momentsDifference(createLocal(duration.from), createLocal(duration.to));

                duration = {};
                duration.ms = diffRes.milliseconds;
                duration.M = diffRes.months;
            }

            ret = new Duration(duration);

            if (isDuration(input) && hasOwnProp(input, '_locale')) {
                ret._locale = input._locale;
            }

            return ret;
        }

        createDuration.fn = Duration.prototype;
        createDuration.invalid = createInvalid$1;

        function parseIso (inp, sign) {
            // We'd normally use ~~inp for this, but unfortunately it also
            // converts floats to ints.
            // inp may be undefined, so careful calling replace on it.
            var res = inp && parseFloat(inp.replace(',', '.'));
            // apply sign while we're at it
            return (isNaN(res) ? 0 : res) * sign;
        }

        function positiveMomentsDifference(base, other) {
            var res = {milliseconds: 0, months: 0};

            res.months = other.month() - base.month() +
                (other.year() - base.year()) * 12;
            if (base.clone().add(res.months, 'M').isAfter(other)) {
                --res.months;
            }

            res.milliseconds = +other - +(base.clone().add(res.months, 'M'));

            return res;
        }

        function momentsDifference(base, other) {
            var res;
            if (!(base.isValid() && other.isValid())) {
                return {milliseconds: 0, months: 0};
            }

            other = cloneWithOffset(other, base);
            if (base.isBefore(other)) {
                res = positiveMomentsDifference(base, other);
            } else {
                res = positiveMomentsDifference(other, base);
                res.milliseconds = -res.milliseconds;
                res.months = -res.months;
            }

            return res;
        }

        // TODO: remove 'name' arg after deprecation is removed
        function createAdder(direction, name) {
            return function (val, period) {
                var dur, tmp;
                //invert the arguments, but complain about it
                if (period !== null && !isNaN(+period)) {
                    deprecateSimple(name, 'moment().' + name  + '(period, number) is deprecated. Please use moment().' + name + '(number, period). ' +
                    'See http://momentjs.com/guides/#/warnings/add-inverted-param/ for more info.');
                    tmp = val; val = period; period = tmp;
                }

                val = typeof val === 'string' ? +val : val;
                dur = createDuration(val, period);
                addSubtract(this, dur, direction);
                return this;
            };
        }

        function addSubtract (mom, duration, isAdding, updateOffset) {
            var milliseconds = duration._milliseconds,
                days = absRound(duration._days),
                months = absRound(duration._months);

            if (!mom.isValid()) {
                // No op
                return;
            }

            updateOffset = updateOffset == null ? true : updateOffset;

            if (months) {
                setMonth(mom, get(mom, 'Month') + months * isAdding);
            }
            if (days) {
                set$1(mom, 'Date', get(mom, 'Date') + days * isAdding);
            }
            if (milliseconds) {
                mom._d.setTime(mom._d.valueOf() + milliseconds * isAdding);
            }
            if (updateOffset) {
                hooks.updateOffset(mom, days || months);
            }
        }

        var add      = createAdder(1, 'add');
        var subtract = createAdder(-1, 'subtract');

        function getCalendarFormat(myMoment, now) {
            var diff = myMoment.diff(now, 'days', true);
            return diff < -6 ? 'sameElse' :
                    diff < -1 ? 'lastWeek' :
                    diff < 0 ? 'lastDay' :
                    diff < 1 ? 'sameDay' :
                    diff < 2 ? 'nextDay' :
                    diff < 7 ? 'nextWeek' : 'sameElse';
        }

        function calendar$1 (time, formats) {
            // We want to compare the start of today, vs this.
            // Getting start-of-today depends on whether we're local/utc/offset or not.
            var now = time || createLocal(),
                sod = cloneWithOffset(now, this).startOf('day'),
                format = hooks.calendarFormat(this, sod) || 'sameElse';

            var output = formats && (isFunction(formats[format]) ? formats[format].call(this, now) : formats[format]);

            return this.format(output || this.localeData().calendar(format, this, createLocal(now)));
        }

        function clone () {
            return new Moment(this);
        }

        function isAfter (input, units) {
            var localInput = isMoment(input) ? input : createLocal(input);
            if (!(this.isValid() && localInput.isValid())) {
                return false;
            }
            units = normalizeUnits(!isUndefined(units) ? units : 'millisecond');
            if (units === 'millisecond') {
                return this.valueOf() > localInput.valueOf();
            } else {
                return localInput.valueOf() < this.clone().startOf(units).valueOf();
            }
        }

        function isBefore (input, units) {
            var localInput = isMoment(input) ? input : createLocal(input);
            if (!(this.isValid() && localInput.isValid())) {
                return false;
            }
            units = normalizeUnits(!isUndefined(units) ? units : 'millisecond');
            if (units === 'millisecond') {
                return this.valueOf() < localInput.valueOf();
            } else {
                return this.clone().endOf(units).valueOf() < localInput.valueOf();
            }
        }

        function isBetween (from, to, units, inclusivity) {
            inclusivity = inclusivity || '()';
            return (inclusivity[0] === '(' ? this.isAfter(from, units) : !this.isBefore(from, units)) &&
                (inclusivity[1] === ')' ? this.isBefore(to, units) : !this.isAfter(to, units));
        }

        function isSame (input, units) {
            var localInput = isMoment(input) ? input : createLocal(input),
                inputMs;
            if (!(this.isValid() && localInput.isValid())) {
                return false;
            }
            units = normalizeUnits(units || 'millisecond');
            if (units === 'millisecond') {
                return this.valueOf() === localInput.valueOf();
            } else {
                inputMs = localInput.valueOf();
                return this.clone().startOf(units).valueOf() <= inputMs && inputMs <= this.clone().endOf(units).valueOf();
            }
        }

        function isSameOrAfter (input, units) {
            return this.isSame(input, units) || this.isAfter(input,units);
        }

        function isSameOrBefore (input, units) {
            return this.isSame(input, units) || this.isBefore(input,units);
        }

        function diff (input, units, asFloat) {
            var that,
                zoneDelta,
                output;

            if (!this.isValid()) {
                return NaN;
            }

            that = cloneWithOffset(input, this);

            if (!that.isValid()) {
                return NaN;
            }

            zoneDelta = (that.utcOffset() - this.utcOffset()) * 6e4;

            units = normalizeUnits(units);

            switch (units) {
                case 'year': output = monthDiff(this, that) / 12; break;
                case 'month': output = monthDiff(this, that); break;
                case 'quarter': output = monthDiff(this, that) / 3; break;
                case 'second': output = (this - that) / 1e3; break; // 1000
                case 'minute': output = (this - that) / 6e4; break; // 1000 * 60
                case 'hour': output = (this - that) / 36e5; break; // 1000 * 60 * 60
                case 'day': output = (this - that - zoneDelta) / 864e5; break; // 1000 * 60 * 60 * 24, negate dst
                case 'week': output = (this - that - zoneDelta) / 6048e5; break; // 1000 * 60 * 60 * 24 * 7, negate dst
                default: output = this - that;
            }

            return asFloat ? output : absFloor(output);
        }

        function monthDiff (a, b) {
            // difference in months
            var wholeMonthDiff = ((b.year() - a.year()) * 12) + (b.month() - a.month()),
                // b is in (anchor - 1 month, anchor + 1 month)
                anchor = a.clone().add(wholeMonthDiff, 'months'),
                anchor2, adjust;

            if (b - anchor < 0) {
                anchor2 = a.clone().add(wholeMonthDiff - 1, 'months');
                // linear across the month
                adjust = (b - anchor) / (anchor - anchor2);
            } else {
                anchor2 = a.clone().add(wholeMonthDiff + 1, 'months');
                // linear across the month
                adjust = (b - anchor) / (anchor2 - anchor);
            }

            //check for negative zero, return zero if negative zero
            return -(wholeMonthDiff + adjust) || 0;
        }

        hooks.defaultFormat = 'YYYY-MM-DDTHH:mm:ssZ';
        hooks.defaultFormatUtc = 'YYYY-MM-DDTHH:mm:ss[Z]';

        function toString () {
            return this.clone().locale('en').format('ddd MMM DD YYYY HH:mm:ss [GMT]ZZ');
        }

        function toISOString(keepOffset) {
            if (!this.isValid()) {
                return null;
            }
            var utc = keepOffset !== true;
            var m = utc ? this.clone().utc() : this;
            if (m.year() < 0 || m.year() > 9999) {
                return formatMoment(m, utc ? 'YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]' : 'YYYYYY-MM-DD[T]HH:mm:ss.SSSZ');
            }
            if (isFunction(Date.prototype.toISOString)) {
                // native implementation is ~50x faster, use it when we can
                if (utc) {
                    return this.toDate().toISOString();
                } else {
                    return new Date(this.valueOf() + this.utcOffset() * 60 * 1000).toISOString().replace('Z', formatMoment(m, 'Z'));
                }
            }
            return formatMoment(m, utc ? 'YYYY-MM-DD[T]HH:mm:ss.SSS[Z]' : 'YYYY-MM-DD[T]HH:mm:ss.SSSZ');
        }

        /**
         * Return a human readable representation of a moment that can
         * also be evaluated to get a new moment which is the same
         *
         * @link https://nodejs.org/dist/latest/docs/api/util.html#util_custom_inspect_function_on_objects
         */
        function inspect () {
            if (!this.isValid()) {
                return 'moment.invalid(/* ' + this._i + ' */)';
            }
            var func = 'moment';
            var zone = '';
            if (!this.isLocal()) {
                func = this.utcOffset() === 0 ? 'moment.utc' : 'moment.parseZone';
                zone = 'Z';
            }
            var prefix = '[' + func + '("]';
            var year = (0 <= this.year() && this.year() <= 9999) ? 'YYYY' : 'YYYYYY';
            var datetime = '-MM-DD[T]HH:mm:ss.SSS';
            var suffix = zone + '[")]';

            return this.format(prefix + year + datetime + suffix);
        }

        function format (inputString) {
            if (!inputString) {
                inputString = this.isUtc() ? hooks.defaultFormatUtc : hooks.defaultFormat;
            }
            var output = formatMoment(this, inputString);
            return this.localeData().postformat(output);
        }

        function from (time, withoutSuffix) {
            if (this.isValid() &&
                    ((isMoment(time) && time.isValid()) ||
                     createLocal(time).isValid())) {
                return createDuration({to: this, from: time}).locale(this.locale()).humanize(!withoutSuffix);
            } else {
                return this.localeData().invalidDate();
            }
        }

        function fromNow (withoutSuffix) {
            return this.from(createLocal(), withoutSuffix);
        }

        function to (time, withoutSuffix) {
            if (this.isValid() &&
                    ((isMoment(time) && time.isValid()) ||
                     createLocal(time).isValid())) {
                return createDuration({from: this, to: time}).locale(this.locale()).humanize(!withoutSuffix);
            } else {
                return this.localeData().invalidDate();
            }
        }

        function toNow (withoutSuffix) {
            return this.to(createLocal(), withoutSuffix);
        }

        // If passed a locale key, it will set the locale for this
        // instance.  Otherwise, it will return the locale configuration
        // variables for this instance.
        function locale (key) {
            var newLocaleData;

            if (key === undefined) {
                return this._locale._abbr;
            } else {
                newLocaleData = getLocale(key);
                if (newLocaleData != null) {
                    this._locale = newLocaleData;
                }
                return this;
            }
        }

        var lang = deprecate(
            'moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.',
            function (key) {
                if (key === undefined) {
                    return this.localeData();
                } else {
                    return this.locale(key);
                }
            }
        );

        function localeData () {
            return this._locale;
        }

        function startOf (units) {
            units = normalizeUnits(units);
            // the following switch intentionally omits break keywords
            // to utilize falling through the cases.
            switch (units) {
                case 'year':
                    this.month(0);
                    /* falls through */
                case 'quarter':
                case 'month':
                    this.date(1);
                    /* falls through */
                case 'week':
                case 'isoWeek':
                case 'day':
                case 'date':
                    this.hours(0);
                    /* falls through */
                case 'hour':
                    this.minutes(0);
                    /* falls through */
                case 'minute':
                    this.seconds(0);
                    /* falls through */
                case 'second':
                    this.milliseconds(0);
            }

            // weeks are a special case
            if (units === 'week') {
                this.weekday(0);
            }
            if (units === 'isoWeek') {
                this.isoWeekday(1);
            }

            // quarters are also special
            if (units === 'quarter') {
                this.month(Math.floor(this.month() / 3) * 3);
            }

            return this;
        }

        function endOf (units) {
            units = normalizeUnits(units);
            if (units === undefined || units === 'millisecond') {
                return this;
            }

            // 'date' is an alias for 'day', so it should be considered as such.
            if (units === 'date') {
                units = 'day';
            }

            return this.startOf(units).add(1, (units === 'isoWeek' ? 'week' : units)).subtract(1, 'ms');
        }

        function valueOf () {
            return this._d.valueOf() - ((this._offset || 0) * 60000);
        }

        function unix () {
            return Math.floor(this.valueOf() / 1000);
        }

        function toDate () {
            return new Date(this.valueOf());
        }

        function toArray () {
            var m = this;
            return [m.year(), m.month(), m.date(), m.hour(), m.minute(), m.second(), m.millisecond()];
        }

        function toObject () {
            var m = this;
            return {
                years: m.year(),
                months: m.month(),
                date: m.date(),
                hours: m.hours(),
                minutes: m.minutes(),
                seconds: m.seconds(),
                milliseconds: m.milliseconds()
            };
        }

        function toJSON () {
            // new Date(NaN).toJSON() === null
            return this.isValid() ? this.toISOString() : null;
        }

        function isValid$2 () {
            return isValid(this);
        }

        function parsingFlags () {
            return extend({}, getParsingFlags(this));
        }

        function invalidAt () {
            return getParsingFlags(this).overflow;
        }

        function creationData() {
            return {
                input: this._i,
                format: this._f,
                locale: this._locale,
                isUTC: this._isUTC,
                strict: this._strict
            };
        }

        // FORMATTING

        addFormatToken(0, ['gg', 2], 0, function () {
            return this.weekYear() % 100;
        });

        addFormatToken(0, ['GG', 2], 0, function () {
            return this.isoWeekYear() % 100;
        });

        function addWeekYearFormatToken (token, getter) {
            addFormatToken(0, [token, token.length], 0, getter);
        }

        addWeekYearFormatToken('gggg',     'weekYear');
        addWeekYearFormatToken('ggggg',    'weekYear');
        addWeekYearFormatToken('GGGG',  'isoWeekYear');
        addWeekYearFormatToken('GGGGG', 'isoWeekYear');

        // ALIASES

        addUnitAlias('weekYear', 'gg');
        addUnitAlias('isoWeekYear', 'GG');

        // PRIORITY

        addUnitPriority('weekYear', 1);
        addUnitPriority('isoWeekYear', 1);


        // PARSING

        addRegexToken('G',      matchSigned);
        addRegexToken('g',      matchSigned);
        addRegexToken('GG',     match1to2, match2);
        addRegexToken('gg',     match1to2, match2);
        addRegexToken('GGGG',   match1to4, match4);
        addRegexToken('gggg',   match1to4, match4);
        addRegexToken('GGGGG',  match1to6, match6);
        addRegexToken('ggggg',  match1to6, match6);

        addWeekParseToken(['gggg', 'ggggg', 'GGGG', 'GGGGG'], function (input, week, config, token) {
            week[token.substr(0, 2)] = toInt(input);
        });

        addWeekParseToken(['gg', 'GG'], function (input, week, config, token) {
            week[token] = hooks.parseTwoDigitYear(input);
        });

        // MOMENTS

        function getSetWeekYear (input) {
            return getSetWeekYearHelper.call(this,
                    input,
                    this.week(),
                    this.weekday(),
                    this.localeData()._week.dow,
                    this.localeData()._week.doy);
        }

        function getSetISOWeekYear (input) {
            return getSetWeekYearHelper.call(this,
                    input, this.isoWeek(), this.isoWeekday(), 1, 4);
        }

        function getISOWeeksInYear () {
            return weeksInYear(this.year(), 1, 4);
        }

        function getWeeksInYear () {
            var weekInfo = this.localeData()._week;
            return weeksInYear(this.year(), weekInfo.dow, weekInfo.doy);
        }

        function getSetWeekYearHelper(input, week, weekday, dow, doy) {
            var weeksTarget;
            if (input == null) {
                return weekOfYear(this, dow, doy).year;
            } else {
                weeksTarget = weeksInYear(input, dow, doy);
                if (week > weeksTarget) {
                    week = weeksTarget;
                }
                return setWeekAll.call(this, input, week, weekday, dow, doy);
            }
        }

        function setWeekAll(weekYear, week, weekday, dow, doy) {
            var dayOfYearData = dayOfYearFromWeeks(weekYear, week, weekday, dow, doy),
                date = createUTCDate(dayOfYearData.year, 0, dayOfYearData.dayOfYear);

            this.year(date.getUTCFullYear());
            this.month(date.getUTCMonth());
            this.date(date.getUTCDate());
            return this;
        }

        // FORMATTING

        addFormatToken('Q', 0, 'Qo', 'quarter');

        // ALIASES

        addUnitAlias('quarter', 'Q');

        // PRIORITY

        addUnitPriority('quarter', 7);

        // PARSING

        addRegexToken('Q', match1);
        addParseToken('Q', function (input, array) {
            array[MONTH] = (toInt(input) - 1) * 3;
        });

        // MOMENTS

        function getSetQuarter (input) {
            return input == null ? Math.ceil((this.month() + 1) / 3) : this.month((input - 1) * 3 + this.month() % 3);
        }

        // FORMATTING

        addFormatToken('D', ['DD', 2], 'Do', 'date');

        // ALIASES

        addUnitAlias('date', 'D');

        // PRIORITY
        addUnitPriority('date', 9);

        // PARSING

        addRegexToken('D',  match1to2);
        addRegexToken('DD', match1to2, match2);
        addRegexToken('Do', function (isStrict, locale) {
            // TODO: Remove "ordinalParse" fallback in next major release.
            return isStrict ?
              (locale._dayOfMonthOrdinalParse || locale._ordinalParse) :
              locale._dayOfMonthOrdinalParseLenient;
        });

        addParseToken(['D', 'DD'], DATE);
        addParseToken('Do', function (input, array) {
            array[DATE] = toInt(input.match(match1to2)[0]);
        });

        // MOMENTS

        var getSetDayOfMonth = makeGetSet('Date', true);

        // FORMATTING

        addFormatToken('DDD', ['DDDD', 3], 'DDDo', 'dayOfYear');

        // ALIASES

        addUnitAlias('dayOfYear', 'DDD');

        // PRIORITY
        addUnitPriority('dayOfYear', 4);

        // PARSING

        addRegexToken('DDD',  match1to3);
        addRegexToken('DDDD', match3);
        addParseToken(['DDD', 'DDDD'], function (input, array, config) {
            config._dayOfYear = toInt(input);
        });

        // HELPERS

        // MOMENTS

        function getSetDayOfYear (input) {
            var dayOfYear = Math.round((this.clone().startOf('day') - this.clone().startOf('year')) / 864e5) + 1;
            return input == null ? dayOfYear : this.add((input - dayOfYear), 'd');
        }

        // FORMATTING

        addFormatToken('m', ['mm', 2], 0, 'minute');

        // ALIASES

        addUnitAlias('minute', 'm');

        // PRIORITY

        addUnitPriority('minute', 14);

        // PARSING

        addRegexToken('m',  match1to2);
        addRegexToken('mm', match1to2, match2);
        addParseToken(['m', 'mm'], MINUTE);

        // MOMENTS

        var getSetMinute = makeGetSet('Minutes', false);

        // FORMATTING

        addFormatToken('s', ['ss', 2], 0, 'second');

        // ALIASES

        addUnitAlias('second', 's');

        // PRIORITY

        addUnitPriority('second', 15);

        // PARSING

        addRegexToken('s',  match1to2);
        addRegexToken('ss', match1to2, match2);
        addParseToken(['s', 'ss'], SECOND);

        // MOMENTS

        var getSetSecond = makeGetSet('Seconds', false);

        // FORMATTING

        addFormatToken('S', 0, 0, function () {
            return ~~(this.millisecond() / 100);
        });

        addFormatToken(0, ['SS', 2], 0, function () {
            return ~~(this.millisecond() / 10);
        });

        addFormatToken(0, ['SSS', 3], 0, 'millisecond');
        addFormatToken(0, ['SSSS', 4], 0, function () {
            return this.millisecond() * 10;
        });
        addFormatToken(0, ['SSSSS', 5], 0, function () {
            return this.millisecond() * 100;
        });
        addFormatToken(0, ['SSSSSS', 6], 0, function () {
            return this.millisecond() * 1000;
        });
        addFormatToken(0, ['SSSSSSS', 7], 0, function () {
            return this.millisecond() * 10000;
        });
        addFormatToken(0, ['SSSSSSSS', 8], 0, function () {
            return this.millisecond() * 100000;
        });
        addFormatToken(0, ['SSSSSSSSS', 9], 0, function () {
            return this.millisecond() * 1000000;
        });


        // ALIASES

        addUnitAlias('millisecond', 'ms');

        // PRIORITY

        addUnitPriority('millisecond', 16);

        // PARSING

        addRegexToken('S',    match1to3, match1);
        addRegexToken('SS',   match1to3, match2);
        addRegexToken('SSS',  match1to3, match3);

        var token;
        for (token = 'SSSS'; token.length <= 9; token += 'S') {
            addRegexToken(token, matchUnsigned);
        }

        function parseMs(input, array) {
            array[MILLISECOND] = toInt(('0.' + input) * 1000);
        }

        for (token = 'S'; token.length <= 9; token += 'S') {
            addParseToken(token, parseMs);
        }
        // MOMENTS

        var getSetMillisecond = makeGetSet('Milliseconds', false);

        // FORMATTING

        addFormatToken('z',  0, 0, 'zoneAbbr');
        addFormatToken('zz', 0, 0, 'zoneName');

        // MOMENTS

        function getZoneAbbr () {
            return this._isUTC ? 'UTC' : '';
        }

        function getZoneName () {
            return this._isUTC ? 'Coordinated Universal Time' : '';
        }

        var proto = Moment.prototype;

        proto.add               = add;
        proto.calendar          = calendar$1;
        proto.clone             = clone;
        proto.diff              = diff;
        proto.endOf             = endOf;
        proto.format            = format;
        proto.from              = from;
        proto.fromNow           = fromNow;
        proto.to                = to;
        proto.toNow             = toNow;
        proto.get               = stringGet;
        proto.invalidAt         = invalidAt;
        proto.isAfter           = isAfter;
        proto.isBefore          = isBefore;
        proto.isBetween         = isBetween;
        proto.isSame            = isSame;
        proto.isSameOrAfter     = isSameOrAfter;
        proto.isSameOrBefore    = isSameOrBefore;
        proto.isValid           = isValid$2;
        proto.lang              = lang;
        proto.locale            = locale;
        proto.localeData        = localeData;
        proto.max               = prototypeMax;
        proto.min               = prototypeMin;
        proto.parsingFlags      = parsingFlags;
        proto.set               = stringSet;
        proto.startOf           = startOf;
        proto.subtract          = subtract;
        proto.toArray           = toArray;
        proto.toObject          = toObject;
        proto.toDate            = toDate;
        proto.toISOString       = toISOString;
        proto.inspect           = inspect;
        proto.toJSON            = toJSON;
        proto.toString          = toString;
        proto.unix              = unix;
        proto.valueOf           = valueOf;
        proto.creationData      = creationData;
        proto.year       = getSetYear;
        proto.isLeapYear = getIsLeapYear;
        proto.weekYear    = getSetWeekYear;
        proto.isoWeekYear = getSetISOWeekYear;
        proto.quarter = proto.quarters = getSetQuarter;
        proto.month       = getSetMonth;
        proto.daysInMonth = getDaysInMonth;
        proto.week           = proto.weeks        = getSetWeek;
        proto.isoWeek        = proto.isoWeeks     = getSetISOWeek;
        proto.weeksInYear    = getWeeksInYear;
        proto.isoWeeksInYear = getISOWeeksInYear;
        proto.date       = getSetDayOfMonth;
        proto.day        = proto.days             = getSetDayOfWeek;
        proto.weekday    = getSetLocaleDayOfWeek;
        proto.isoWeekday = getSetISODayOfWeek;
        proto.dayOfYear  = getSetDayOfYear;
        proto.hour = proto.hours = getSetHour;
        proto.minute = proto.minutes = getSetMinute;
        proto.second = proto.seconds = getSetSecond;
        proto.millisecond = proto.milliseconds = getSetMillisecond;
        proto.utcOffset            = getSetOffset;
        proto.utc                  = setOffsetToUTC;
        proto.local                = setOffsetToLocal;
        proto.parseZone            = setOffsetToParsedOffset;
        proto.hasAlignedHourOffset = hasAlignedHourOffset;
        proto.isDST                = isDaylightSavingTime;
        proto.isLocal              = isLocal;
        proto.isUtcOffset          = isUtcOffset;
        proto.isUtc                = isUtc;
        proto.isUTC                = isUtc;
        proto.zoneAbbr = getZoneAbbr;
        proto.zoneName = getZoneName;
        proto.dates  = deprecate('dates accessor is deprecated. Use date instead.', getSetDayOfMonth);
        proto.months = deprecate('months accessor is deprecated. Use month instead', getSetMonth);
        proto.years  = deprecate('years accessor is deprecated. Use year instead', getSetYear);
        proto.zone   = deprecate('moment().zone is deprecated, use moment().utcOffset instead. http://momentjs.com/guides/#/warnings/zone/', getSetZone);
        proto.isDSTShifted = deprecate('isDSTShifted is deprecated. See http://momentjs.com/guides/#/warnings/dst-shifted/ for more information', isDaylightSavingTimeShifted);

        function createUnix (input) {
            return createLocal(input * 1000);
        }

        function createInZone () {
            return createLocal.apply(null, arguments).parseZone();
        }

        function preParsePostFormat (string) {
            return string;
        }

        var proto$1 = Locale.prototype;

        proto$1.calendar        = calendar;
        proto$1.longDateFormat  = longDateFormat;
        proto$1.invalidDate     = invalidDate;
        proto$1.ordinal         = ordinal;
        proto$1.preparse        = preParsePostFormat;
        proto$1.postformat      = preParsePostFormat;
        proto$1.relativeTime    = relativeTime;
        proto$1.pastFuture      = pastFuture;
        proto$1.set             = set;

        proto$1.months            =        localeMonths;
        proto$1.monthsShort       =        localeMonthsShort;
        proto$1.monthsParse       =        localeMonthsParse;
        proto$1.monthsRegex       = monthsRegex;
        proto$1.monthsShortRegex  = monthsShortRegex;
        proto$1.week = localeWeek;
        proto$1.firstDayOfYear = localeFirstDayOfYear;
        proto$1.firstDayOfWeek = localeFirstDayOfWeek;

        proto$1.weekdays       =        localeWeekdays;
        proto$1.weekdaysMin    =        localeWeekdaysMin;
        proto$1.weekdaysShort  =        localeWeekdaysShort;
        proto$1.weekdaysParse  =        localeWeekdaysParse;

        proto$1.weekdaysRegex       =        weekdaysRegex;
        proto$1.weekdaysShortRegex  =        weekdaysShortRegex;
        proto$1.weekdaysMinRegex    =        weekdaysMinRegex;

        proto$1.isPM = localeIsPM;
        proto$1.meridiem = localeMeridiem;

        function get$1 (format, index, field, setter) {
            var locale = getLocale();
            var utc = createUTC().set(setter, index);
            return locale[field](utc, format);
        }

        function listMonthsImpl (format, index, field) {
            if (isNumber(format)) {
                index = format;
                format = undefined;
            }

            format = format || '';

            if (index != null) {
                return get$1(format, index, field, 'month');
            }

            var i;
            var out = [];
            for (i = 0; i < 12; i++) {
                out[i] = get$1(format, i, field, 'month');
            }
            return out;
        }

        // ()
        // (5)
        // (fmt, 5)
        // (fmt)
        // (true)
        // (true, 5)
        // (true, fmt, 5)
        // (true, fmt)
        function listWeekdaysImpl (localeSorted, format, index, field) {
            if (typeof localeSorted === 'boolean') {
                if (isNumber(format)) {
                    index = format;
                    format = undefined;
                }

                format = format || '';
            } else {
                format = localeSorted;
                index = format;
                localeSorted = false;

                if (isNumber(format)) {
                    index = format;
                    format = undefined;
                }

                format = format || '';
            }

            var locale = getLocale(),
                shift = localeSorted ? locale._week.dow : 0;

            if (index != null) {
                return get$1(format, (index + shift) % 7, field, 'day');
            }

            var i;
            var out = [];
            for (i = 0; i < 7; i++) {
                out[i] = get$1(format, (i + shift) % 7, field, 'day');
            }
            return out;
        }

        function listMonths (format, index) {
            return listMonthsImpl(format, index, 'months');
        }

        function listMonthsShort (format, index) {
            return listMonthsImpl(format, index, 'monthsShort');
        }

        function listWeekdays (localeSorted, format, index) {
            return listWeekdaysImpl(localeSorted, format, index, 'weekdays');
        }

        function listWeekdaysShort (localeSorted, format, index) {
            return listWeekdaysImpl(localeSorted, format, index, 'weekdaysShort');
        }

        function listWeekdaysMin (localeSorted, format, index) {
            return listWeekdaysImpl(localeSorted, format, index, 'weekdaysMin');
        }

        getSetGlobalLocale('en', {
            dayOfMonthOrdinalParse: /\d{1,2}(th|st|nd|rd)/,
            ordinal : function (number) {
                var b = number % 10,
                    output = (toInt(number % 100 / 10) === 1) ? 'th' :
                    (b === 1) ? 'st' :
                    (b === 2) ? 'nd' :
                    (b === 3) ? 'rd' : 'th';
                return number + output;
            }
        });

        // Side effect imports

        hooks.lang = deprecate('moment.lang is deprecated. Use moment.locale instead.', getSetGlobalLocale);
        hooks.langData = deprecate('moment.langData is deprecated. Use moment.localeData instead.', getLocale);

        var mathAbs = Math.abs;

        function abs () {
            var data           = this._data;

            this._milliseconds = mathAbs(this._milliseconds);
            this._days         = mathAbs(this._days);
            this._months       = mathAbs(this._months);

            data.milliseconds  = mathAbs(data.milliseconds);
            data.seconds       = mathAbs(data.seconds);
            data.minutes       = mathAbs(data.minutes);
            data.hours         = mathAbs(data.hours);
            data.months        = mathAbs(data.months);
            data.years         = mathAbs(data.years);

            return this;
        }

        function addSubtract$1 (duration, input, value, direction) {
            var other = createDuration(input, value);

            duration._milliseconds += direction * other._milliseconds;
            duration._days         += direction * other._days;
            duration._months       += direction * other._months;

            return duration._bubble();
        }

        // supports only 2.0-style add(1, 's') or add(duration)
        function add$1 (input, value) {
            return addSubtract$1(this, input, value, 1);
        }

        // supports only 2.0-style subtract(1, 's') or subtract(duration)
        function subtract$1 (input, value) {
            return addSubtract$1(this, input, value, -1);
        }

        function absCeil (number) {
            if (number < 0) {
                return Math.floor(number);
            } else {
                return Math.ceil(number);
            }
        }

        function bubble () {
            var milliseconds = this._milliseconds;
            var days         = this._days;
            var months       = this._months;
            var data         = this._data;
            var seconds, minutes, hours, years, monthsFromDays;

            // if we have a mix of positive and negative values, bubble down first
            // check: https://github.com/moment/moment/issues/2166
            if (!((milliseconds >= 0 && days >= 0 && months >= 0) ||
                    (milliseconds <= 0 && days <= 0 && months <= 0))) {
                milliseconds += absCeil(monthsToDays(months) + days) * 864e5;
                days = 0;
                months = 0;
            }

            // The following code bubbles up values, see the tests for
            // examples of what that means.
            data.milliseconds = milliseconds % 1000;

            seconds           = absFloor(milliseconds / 1000);
            data.seconds      = seconds % 60;

            minutes           = absFloor(seconds / 60);
            data.minutes      = minutes % 60;

            hours             = absFloor(minutes / 60);
            data.hours        = hours % 24;

            days += absFloor(hours / 24);

            // convert days to months
            monthsFromDays = absFloor(daysToMonths(days));
            months += monthsFromDays;
            days -= absCeil(monthsToDays(monthsFromDays));

            // 12 months -> 1 year
            years = absFloor(months / 12);
            months %= 12;

            data.days   = days;
            data.months = months;
            data.years  = years;

            return this;
        }

        function daysToMonths (days) {
            // 400 years have 146097 days (taking into account leap year rules)
            // 400 years have 12 months === 4800
            return days * 4800 / 146097;
        }

        function monthsToDays (months) {
            // the reverse of daysToMonths
            return months * 146097 / 4800;
        }

        function as (units) {
            if (!this.isValid()) {
                return NaN;
            }
            var days;
            var months;
            var milliseconds = this._milliseconds;

            units = normalizeUnits(units);

            if (units === 'month' || units === 'year') {
                days   = this._days   + milliseconds / 864e5;
                months = this._months + daysToMonths(days);
                return units === 'month' ? months : months / 12;
            } else {
                // handle milliseconds separately because of floating point math errors (issue #1867)
                days = this._days + Math.round(monthsToDays(this._months));
                switch (units) {
                    case 'week'   : return days / 7     + milliseconds / 6048e5;
                    case 'day'    : return days         + milliseconds / 864e5;
                    case 'hour'   : return days * 24    + milliseconds / 36e5;
                    case 'minute' : return days * 1440  + milliseconds / 6e4;
                    case 'second' : return days * 86400 + milliseconds / 1000;
                    // Math.floor prevents floating point math errors here
                    case 'millisecond': return Math.floor(days * 864e5) + milliseconds;
                    default: throw new Error('Unknown unit ' + units);
                }
            }
        }

        // TODO: Use this.as('ms')?
        function valueOf$1 () {
            if (!this.isValid()) {
                return NaN;
            }
            return (
                this._milliseconds +
                this._days * 864e5 +
                (this._months % 12) * 2592e6 +
                toInt(this._months / 12) * 31536e6
            );
        }

        function makeAs (alias) {
            return function () {
                return this.as(alias);
            };
        }

        var asMilliseconds = makeAs('ms');
        var asSeconds      = makeAs('s');
        var asMinutes      = makeAs('m');
        var asHours        = makeAs('h');
        var asDays         = makeAs('d');
        var asWeeks        = makeAs('w');
        var asMonths       = makeAs('M');
        var asYears        = makeAs('y');

        function clone$1 () {
            return createDuration(this);
        }

        function get$2 (units) {
            units = normalizeUnits(units);
            return this.isValid() ? this[units + 's']() : NaN;
        }

        function makeGetter(name) {
            return function () {
                return this.isValid() ? this._data[name] : NaN;
            };
        }

        var milliseconds = makeGetter('milliseconds');
        var seconds      = makeGetter('seconds');
        var minutes      = makeGetter('minutes');
        var hours        = makeGetter('hours');
        var days         = makeGetter('days');
        var months       = makeGetter('months');
        var years        = makeGetter('years');

        function weeks () {
            return absFloor(this.days() / 7);
        }

        var round = Math.round;
        var thresholds = {
            ss: 44,         // a few seconds to seconds
            s : 45,         // seconds to minute
            m : 45,         // minutes to hour
            h : 22,         // hours to day
            d : 26,         // days to month
            M : 11          // months to year
        };

        // helper function for moment.fn.from, moment.fn.fromNow, and moment.duration.fn.humanize
        function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale) {
            return locale.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
        }

        function relativeTime$1 (posNegDuration, withoutSuffix, locale) {
            var duration = createDuration(posNegDuration).abs();
            var seconds  = round(duration.as('s'));
            var minutes  = round(duration.as('m'));
            var hours    = round(duration.as('h'));
            var days     = round(duration.as('d'));
            var months   = round(duration.as('M'));
            var years    = round(duration.as('y'));

            var a = seconds <= thresholds.ss && ['s', seconds]  ||
                    seconds < thresholds.s   && ['ss', seconds] ||
                    minutes <= 1             && ['m']           ||
                    minutes < thresholds.m   && ['mm', minutes] ||
                    hours   <= 1             && ['h']           ||
                    hours   < thresholds.h   && ['hh', hours]   ||
                    days    <= 1             && ['d']           ||
                    days    < thresholds.d   && ['dd', days]    ||
                    months  <= 1             && ['M']           ||
                    months  < thresholds.M   && ['MM', months]  ||
                    years   <= 1             && ['y']           || ['yy', years];

            a[2] = withoutSuffix;
            a[3] = +posNegDuration > 0;
            a[4] = locale;
            return substituteTimeAgo.apply(null, a);
        }

        // This function allows you to set the rounding function for relative time strings
        function getSetRelativeTimeRounding (roundingFunction) {
            if (roundingFunction === undefined) {
                return round;
            }
            if (typeof(roundingFunction) === 'function') {
                round = roundingFunction;
                return true;
            }
            return false;
        }

        // This function allows you to set a threshold for relative time strings
        function getSetRelativeTimeThreshold (threshold, limit) {
            if (thresholds[threshold] === undefined) {
                return false;
            }
            if (limit === undefined) {
                return thresholds[threshold];
            }
            thresholds[threshold] = limit;
            if (threshold === 's') {
                thresholds.ss = limit - 1;
            }
            return true;
        }

        function humanize (withSuffix) {
            if (!this.isValid()) {
                return this.localeData().invalidDate();
            }

            var locale = this.localeData();
            var output = relativeTime$1(this, !withSuffix, locale);

            if (withSuffix) {
                output = locale.pastFuture(+this, output);
            }

            return locale.postformat(output);
        }

        var abs$1 = Math.abs;

        function sign(x) {
            return ((x > 0) - (x < 0)) || +x;
        }

        function toISOString$1() {
            // for ISO strings we do not use the normal bubbling rules:
            //  * milliseconds bubble up until they become hours
            //  * days do not bubble at all
            //  * months bubble up until they become years
            // This is because there is no context-free conversion between hours and days
            // (think of clock changes)
            // and also not between days and months (28-31 days per month)
            if (!this.isValid()) {
                return this.localeData().invalidDate();
            }

            var seconds = abs$1(this._milliseconds) / 1000;
            var days         = abs$1(this._days);
            var months       = abs$1(this._months);
            var minutes, hours, years;

            // 3600 seconds -> 60 minutes -> 1 hour
            minutes           = absFloor(seconds / 60);
            hours             = absFloor(minutes / 60);
            seconds %= 60;
            minutes %= 60;

            // 12 months -> 1 year
            years  = absFloor(months / 12);
            months %= 12;


            // inspired by https://github.com/dordille/moment-isoduration/blob/master/moment.isoduration.js
            var Y = years;
            var M = months;
            var D = days;
            var h = hours;
            var m = minutes;
            var s = seconds ? seconds.toFixed(3).replace(/\.?0+$/, '') : '';
            var total = this.asSeconds();

            if (!total) {
                // this is the same as C#'s (Noda) and python (isodate)...
                // but not other JS (goog.date)
                return 'P0D';
            }

            var totalSign = total < 0 ? '-' : '';
            var ymSign = sign(this._months) !== sign(total) ? '-' : '';
            var daysSign = sign(this._days) !== sign(total) ? '-' : '';
            var hmsSign = sign(this._milliseconds) !== sign(total) ? '-' : '';

            return totalSign + 'P' +
                (Y ? ymSign + Y + 'Y' : '') +
                (M ? ymSign + M + 'M' : '') +
                (D ? daysSign + D + 'D' : '') +
                ((h || m || s) ? 'T' : '') +
                (h ? hmsSign + h + 'H' : '') +
                (m ? hmsSign + m + 'M' : '') +
                (s ? hmsSign + s + 'S' : '');
        }

        var proto$2 = Duration.prototype;

        proto$2.isValid        = isValid$1;
        proto$2.abs            = abs;
        proto$2.add            = add$1;
        proto$2.subtract       = subtract$1;
        proto$2.as             = as;
        proto$2.asMilliseconds = asMilliseconds;
        proto$2.asSeconds      = asSeconds;
        proto$2.asMinutes      = asMinutes;
        proto$2.asHours        = asHours;
        proto$2.asDays         = asDays;
        proto$2.asWeeks        = asWeeks;
        proto$2.asMonths       = asMonths;
        proto$2.asYears        = asYears;
        proto$2.valueOf        = valueOf$1;
        proto$2._bubble        = bubble;
        proto$2.clone          = clone$1;
        proto$2.get            = get$2;
        proto$2.milliseconds   = milliseconds;
        proto$2.seconds        = seconds;
        proto$2.minutes        = minutes;
        proto$2.hours          = hours;
        proto$2.days           = days;
        proto$2.weeks          = weeks;
        proto$2.months         = months;
        proto$2.years          = years;
        proto$2.humanize       = humanize;
        proto$2.toISOString    = toISOString$1;
        proto$2.toString       = toISOString$1;
        proto$2.toJSON         = toISOString$1;
        proto$2.locale         = locale;
        proto$2.localeData     = localeData;

        proto$2.toIsoString = deprecate('toIsoString() is deprecated. Please use toISOString() instead (notice the capitals)', toISOString$1);
        proto$2.lang = lang;

        // Side effect imports

        // FORMATTING

        addFormatToken('X', 0, 0, 'unix');
        addFormatToken('x', 0, 0, 'valueOf');

        // PARSING

        addRegexToken('x', matchSigned);
        addRegexToken('X', matchTimestamp);
        addParseToken('X', function (input, array, config) {
            config._d = new Date(parseFloat(input, 10) * 1000);
        });
        addParseToken('x', function (input, array, config) {
            config._d = new Date(toInt(input));
        });

        // Side effect imports


        hooks.version = '2.22.1';

        setHookCallback(createLocal);

        hooks.fn                    = proto;
        hooks.min                   = min;
        hooks.max                   = max;
        hooks.now                   = now;
        hooks.utc                   = createUTC;
        hooks.unix                  = createUnix;
        hooks.months                = listMonths;
        hooks.isDate                = isDate;
        hooks.locale                = getSetGlobalLocale;
        hooks.invalid               = createInvalid;
        hooks.duration              = createDuration;
        hooks.isMoment              = isMoment;
        hooks.weekdays              = listWeekdays;
        hooks.parseZone             = createInZone;
        hooks.localeData            = getLocale;
        hooks.isDuration            = isDuration;
        hooks.monthsShort           = listMonthsShort;
        hooks.weekdaysMin           = listWeekdaysMin;
        hooks.defineLocale          = defineLocale;
        hooks.updateLocale          = updateLocale;
        hooks.locales               = listLocales;
        hooks.weekdaysShort         = listWeekdaysShort;
        hooks.normalizeUnits        = normalizeUnits;
        hooks.relativeTimeRounding  = getSetRelativeTimeRounding;
        hooks.relativeTimeThreshold = getSetRelativeTimeThreshold;
        hooks.calendarFormat        = getCalendarFormat;
        hooks.prototype             = proto;

        // currently HTML5 input type only supports 24-hour formats
        hooks.HTML5_FMT = {
            DATETIME_LOCAL: 'YYYY-MM-DDTHH:mm',             // <input type="datetime-local" />
            DATETIME_LOCAL_SECONDS: 'YYYY-MM-DDTHH:mm:ss',  // <input type="datetime-local" step="1" />
            DATETIME_LOCAL_MS: 'YYYY-MM-DDTHH:mm:ss.SSS',   // <input type="datetime-local" step="0.001" />
            DATE: 'YYYY-MM-DD',                             // <input type="date" />
            TIME: 'HH:mm',                                  // <input type="time" />
            TIME_SECONDS: 'HH:mm:ss',                       // <input type="time" step="1" />
            TIME_MS: 'HH:mm:ss.SSS',                        // <input type="time" step="0.001" />
            WEEK: 'YYYY-[W]WW',                             // <input type="week" />
            MONTH: 'YYYY-MM'                                // <input type="month" />
        };

        return hooks;

    })));
    });

    const markdown = new (showdown.Converter)();



    var format = {
        format(value, field) {
            if (typeof field === 'string') {
                field = {fieldtype: field};
            }

            if (field.fieldtype==='Currency') {
                value = number_format.format_number(value);

            } else if (field.fieldtype === 'Text') {
                value = markdown.makeHtml(value || '');

            } else if (field.fieldtype === 'Date') {
                let dateFormat;
                if (!frappejs.SystemSettings) {
                    dateFormat = 'yyyy-mm-dd';
                } else {
                    dateFormat = frappejs.SystemSettings.dateFormat;
                }

                value = moment(value).format(dateFormat.toUpperCase());

            } else {
                if (value===null || value===undefined) {
                    value = '';
                } else {
                    value = value + '';
                }
            }
            return value;
        }
    };

    class BaseError extends Error {
        constructor(status_code, ...params) {
            super(...params);
            this.status_code = status_code;
        }
    }

    class ValidationError extends BaseError {
        constructor(...params) { super(417, ...params); }
    }

    var errors = {
        ValidationError: ValidationError,
        ValueError: class ValueError extends ValidationError { },
        Conflict: class Conflict extends ValidationError { },
        NotFound: class NotFound extends BaseError {
            constructor(...params) { super(404, ...params); }
        },
        Forbidden: class Forbidden extends BaseError {
            constructor(...params) { super(403, ...params); }
        },
    };

    var observable = class Observable {
        constructor() {
            this._observable = {
                isHot: {},
                eventQueue: {},
                listeners: {},
                onceListeners: {}
            };
        }

        // getter, setter stubs, so Observable can be used as a simple Document
        get(key) {
            return this[key];
        }

        set(key, value) {
            this[key] = value;
            this.trigger('change', {doc: this, fieldname: key});
        }

        on(event, listener) {
            this._addListener('listeners', event, listener);
            if (this._observable.socketClient) {
                this._observable.socketClient.on(event, listener);
            }
        }

        // remove listener
        off(event, listener) {
            for (let type of ['listeners', 'onceListeners']) {
                let index = this._observable[type][event] && this._observable[type][event].indexOf(listener);
                if (index) {
                    this._observable[type][event].splice(index, 1);
                }
            }
        }

        once(event, listener) {
            this._addListener('onceListeners', event, listener);
        }

        async trigger(event, params, throttle=false) {
            if (throttle) {
                if (this._throttled(event, params, throttle)) return;
                params = [params];
            }

            await this._executeTriggers(event, params);
        }

        async _executeTriggers(event, params) {
            let response = await this._triggerEvent('listeners', event, params);
            if (response === false) return false;

            response = await this._triggerEvent('onceListeners', event, params);
            if (response === false) return false;

            // emit via socket
            if (this._observable.socketServer) {
                this._observable.socketServer.emit(event, params);
            }

            // clear once-listeners
            if (this._observable.onceListeners && this._observable.onceListeners[event]) {
                delete this._observable.onceListeners[event];
            }

        }

        clearListeners() {
            this._observable.listeners = {};
            this._observable.onceListeners = {};
        }

        bindSocketClient(socket) {
            // also send events with sockets
            this._observable.socketClient = socket;
        }

        bindSocketServer(socket) {
            // also send events with sockets
            this._observable.socketServer = socket;
        }

        _throttled(event, params, throttle) {
            if (this._observable.isHot[event]) {
                // hot, add to queue
                if (!this._observable.eventQueue[event]) this._observable.eventQueue[event] = [];
                this._observable.eventQueue[event].push(params);

                // aleady hot, quit
                return true;
            }
            this._observable.isHot[event] = true;

            // cool-off
            setTimeout(() => {
                this._observable.isHot[event] = false;

                // flush queue
                if (this._observable.eventQueue[event]) {
                    let _queuedParams = this._observable.eventQueue[event];
                    this._observable.eventQueue[event] = null;
                    this._executeTriggers(event, _queuedParams);
                }
            }, throttle);

            return false;
        }

        _addListener(type, event, listener) {
            if (!this._observable[type][event]) {
                this._observable[type][event] = [];
            }
            this._observable[type][event].push(listener);
        }

        async _triggerEvent(type, event, params) {
            if (this._observable[type][event]) {
                for (let listener of this._observable[type][event]) {
                    await listener(params);
                }
            }
        }
    };

    var naming = {
        async setName(doc) {
            if (frappejs.isServer) {
                // if is server, always name again if autoincrement or other
                if (doc.meta.naming === 'autoincrement') {
                    doc.name = await this.getNextId(doc.doctype);
                    return;
                }

                if (doc.meta.settings) {
                    const numberSeries = (await doc.getSettings()).numberSeries;
                    if(numberSeries) {
                        doc.name = await this.getSeriesNext(numberSeries);
                    }
                }
            }

            if (doc.name) {
                return;
            }

            // name === doctype for Single
            if (doc.meta.isSingle) {
                doc.name = doc.meta.name;
                return;
            }

            // assign a random name by default
            // override doc to set a name
            if (!doc.name) {
                doc.name = frappejs.getRandomString();
            }
        },

        async getNextId(doctype) {
            // get the last inserted row
            let lastInserted = await this.getLastInserted(doctype);
            let name = 1;
            if (lastInserted) {
                let lastNumber = parseInt(lastInserted.name);
                if (isNaN(lastNumber)) lastNumber = 0;
                name = lastNumber + 1;
            }
            return (name + '').padStart(9, '0');
        },

        async getLastInserted(doctype) {
            const lastInserted = await frappejs.db.getAll({
                doctype: doctype,
                fields: ['name'],
                limit: 1,
                order_by: 'creation',
                order: 'desc'
            });
            return (lastInserted && lastInserted.length) ? lastInserted[0] : null;
        },

        async getSeriesNext(prefix) {
            let series;
            try {
                series = await frappejs.getDoc('NumberSeries', prefix);
            } catch (e) {
                if (!e.status_code || e.status_code !== 404) {
                    throw e;
                }
                await this.createNumberSeries(prefix);
            }
            let next = await series.next();
            return prefix + next;
        },

        async createNumberSeries(prefix, setting, start=1000) {
            if (!(await frappejs.db.exists('NumberSeries', prefix))) {
                const series = frappejs.newDoc({doctype: 'NumberSeries', name: prefix, current: start});
                await series.insert();

                if (setting) {
                    const settingDoc = await frappejs.getSingle(setting);
                    settingDoc.numberSeries = series.name;
                    await settingDoc.update();
                }
            }
        }
    };

    var document$1 = class BaseDocument extends observable {
        constructor(data) {
            super();
            this.fetchValuesCache = {};
            this.flags = {};
            this.setup();
            Object.assign(this, data);

            // clear fetch-values cache
            frappejs.db.on('change', (params) => this.fetchValuesCache[`${params.doctype}:${params.name}`] = {});
        }

        setup() {
            // add listeners
        }

        get meta() {
            if (!this._meta) {
                this._meta = frappejs.getMeta(this.doctype);
            }
            return this._meta;
        }

        async getSettings() {
            if (!this._settings) {
                this._settings = await frappejs.getSingle(this.meta.settings);
            }
            return this._settings;
        }

        // set value and trigger change
        async set(fieldname, value) {
            if (this[fieldname] !== value) {
                this._dirty = true;
                this[fieldname] = await this.validateField(fieldname, value);
                await this.applyChange(fieldname);
            }
        }

        async applyChange(fieldname) {
            if (await this.applyFormula()) {
                // multiple changes
                await this.trigger('change', { doc: this });
            } else {
                // no other change, trigger control refresh
                await this.trigger('change', { doc: this, fieldname: fieldname });
            }
        }

        setDefaults() {
            for (let field of this.meta.fields) {
                if (this[field.fieldname]===null || this[field.fieldname]===undefined) {
                    if (field.fieldtype === 'Date') {
                        this[field.fieldname] = (new Date()).toISOString().substr(0, 10);
                    } else if(field.default) {
                        this[field.fieldname] = field.default;
                    }
                }
            }
        }

        setKeywords() {
            let keywords = [];
            for (let fieldname of this.meta.getKeywordFields()) {
                keywords.push(this[fieldname]);
            }
            this.keywords = keywords.join(', ');
        }

        append(key, document) {
            if (!this[key]) {
                this[key] = [];
            }
            this[key].push(this.initDoc(document));
        }

        initDoc(data) {
            if (data.prototype instanceof Document) {
                return data;
            } else {
                return new Document(data);
            }
        }

        async validateField(key, value) {
            let field = this.meta.getField(key);
            if (field && field.fieldtype == 'Select') {
                return this.meta.validateSelect(field, value);
            }
            return value;
        }

        getValidDict() {
            let data = {};
            for (let field of this.meta.getValidFields()) {
                data[field.fieldname] = this[field.fieldname];
            }
            return data;
        }

        getFullDict() {
            let data = this.getValidDict();
            return data;
        }

        setStandardValues() {
            // set standard values on server-side only
            if (frappejs.isServer) {
                let now = (new Date()).toISOString();
                if (!this.submitted) {
                    this.submitted = 0;
                }

                if (!this.owner) {
                    this.owner = frappejs.session.user;
                }

                if (!this.creation) {
                    this.creation = now;
                }

                if (!this.modifiedBy) {
                    this.modifiedBy = frappejs.session.user;
                }
                this.modified = now;
            }
        }

        async load() {
            let data = await frappejs.db.get(this.doctype, this.name);
            if (data.name) {
                this.syncValues(data);
                if (this.meta.isSingle) {
                    this.setDefaults();
                }
            } else {
                throw new frappejs.errors.NotFound(`Not Found: ${this.doctype} ${this.name}`);
            }
        }

        syncValues(data) {
            this.clearValues();
            Object.assign(this, data);
            this._dirty = false;
            this.trigger('change', {doc: this});
        }

        clearValues() {
            for (let field of this.meta.getValidFields()) {
                if(this[field.fieldname]) {
                    delete this[field.fieldname];
                }
            }
        }

        setChildIdx() {
            // renumber children
            for (let field of this.meta.getValidFields()) {
                if (field.fieldtype==='Table') {
                    for(let i=0; i < (this[field.fieldname] || []).length; i++) {
                        this[field.fieldname][i].idx = i;
                    }
                }
            }
        }

        async compareWithCurrentDoc() {
            if (frappejs.isServer && !this._notInserted) {
                let currentDoc = await frappejs.db.get(this.doctype, this.name);

                // check for conflict
                if (currentDoc && this.modified != currentDoc.modified) {
                    throw new frappejs.errors.Conflict(frappejs._('Document {0} {1} has been modified after loading', [this.doctype, this.name]));
                }

                if (this.submitted && !this.meta.isSubmittable) {
                    throw new frappejs.errors.ValidationError(frappejs._('Document type {1} is not submittable', [this.doctype]));
                }

                // set submit action flag
                if (this.submitted && !currentDoc.submitted) {
                    this.flags.submitAction = true;
                }

                if (currentDoc.submitted && !this.submitted) {
                    this.flags.revertAction = true;
                }

            }
        }

        async applyFormula() {
            if (!this.meta.hasFormula()) {
                return false;
            }

            let doc = this;

            // children
            for (let tablefield of this.meta.getTableFields()) {
                let formulaFields = frappejs.getMeta(tablefield.childtype).getFormulaFields();
                if (formulaFields.length) {

                    // for each row
                    for (let row of this[tablefield.fieldname]) {
                        for (let field of formulaFields) {
                            const val = await field.formula(row, doc);
                            if (val !== false) {
                                row[field.fieldname] = val;
                            }
                        }
                    }
                }
            }

            // parent
            for (let field of this.meta.getFormulaFields()) {
                const val = await field.formula(doc);
                if (val !== false) {
                    doc[field.fieldname] = val;
                }
            }

            return true;
        }

        async commit() {
            // re-run triggers
            this.setStandardValues();
            this.setKeywords();
            this.setChildIdx();
            await this.applyFormula();
            await this.trigger('validate');
        }

        async insert() {
            await naming.setName(this);
            await this.commit();
            await this.trigger('beforeInsert');

            const data = await frappejs.db.insert(this.doctype, this.getValidDict());
            this.syncValues(data);

            await this.trigger('afterInsert');
            await this.trigger('afterSave');

            return this;
        }

        async update() {
            await this.compareWithCurrentDoc();
            await this.commit();
            await this.trigger('beforeUpdate');

            // before submit
            if (this.flags.submitAction) await this.trigger('beforeSubmit');
            if (this.flags.revertAction) await this.trigger('beforeRevert');

            const data = await frappejs.db.update(this.doctype, this.getValidDict());
            this.syncValues(data);

            await this.trigger('afterUpdate');
            await this.trigger('afterSave');

            // after submit
            if (this.flags.submitAction) await this.trigger('afterSubmit');
            if (this.flags.revertAction) await this.trigger('afterRevert');

            return this;
        }

        async delete() {
            await this.trigger('before_delete');
            await frappejs.db.delete(this.doctype, this.name);
            await this.trigger('after_delete');
        }

        async submit() {
            this.submitted = 1;
            this.update();
        }

        async revert() {
            this.submitted = 0;
            this.update();
        }

        // trigger methods on the class if they match
        // with the trigger name
        async trigger(event, params) {
            if (this[event]) {
                await this[event](params);
            }
            await super.trigger(event, params);
        }

        // helper functions
        getSum(tablefield, childfield) {
            return this[tablefield].map(d => (d[childfield] || 0)).reduce((a, b) => a + b, 0);
        }

        async getFrom(doctype, name, fieldname) {
            if (!name) return '';
            let _values = this.fetchValuesCache[`${doctype}:${name}`] || (this.fetchValuesCache[`${doctype}:${name}`] = {});
            if (!_values[fieldname]) {
                _values[fieldname] = await frappejs.db.getValue(doctype, name, fieldname);
            }
            return _values[fieldname];
        }
    };

    var isMergeableObject = function isMergeableObject(value) {
    	return isNonNullObject(value)
    		&& !isSpecial(value)
    };

    function isNonNullObject(value) {
    	return !!value && typeof value === 'object'
    }

    function isSpecial(value) {
    	var stringValue = Object.prototype.toString.call(value);

    	return stringValue === '[object RegExp]'
    		|| stringValue === '[object Date]'
    		|| isReactElement(value)
    }

    // see https://github.com/facebook/react/blob/b5ac963fb791d1298e7f396236383bc955f916c1/src/isomorphic/classic/element/ReactElement.js#L21-L25
    var canUseSymbol = typeof Symbol === 'function' && Symbol.for;
    var REACT_ELEMENT_TYPE = canUseSymbol ? Symbol.for('react.element') : 0xeac7;

    function isReactElement(value) {
    	return value.$$typeof === REACT_ELEMENT_TYPE
    }

    function emptyTarget(val) {
    	return Array.isArray(val) ? [] : {}
    }

    function cloneUnlessOtherwiseSpecified(value, options) {
    	return (options.clone !== false && options.isMergeableObject(value))
    		? deepmerge(emptyTarget(value), value, options)
    		: value
    }

    function defaultArrayMerge(target, source, options) {
    	return target.concat(source).map(function(element) {
    		return cloneUnlessOtherwiseSpecified(element, options)
    	})
    }

    function mergeObject(target, source, options) {
    	var destination = {};
    	if (options.isMergeableObject(target)) {
    		Object.keys(target).forEach(function(key) {
    			destination[key] = cloneUnlessOtherwiseSpecified(target[key], options);
    		});
    	}
    	Object.keys(source).forEach(function(key) {
    		if (!options.isMergeableObject(source[key]) || !target[key]) {
    			destination[key] = cloneUnlessOtherwiseSpecified(source[key], options);
    		} else {
    			destination[key] = deepmerge(target[key], source[key], options);
    		}
    	});
    	return destination
    }

    function deepmerge(target, source, options) {
    	options = options || {};
    	options.arrayMerge = options.arrayMerge || defaultArrayMerge;
    	options.isMergeableObject = options.isMergeableObject || isMergeableObject;

    	var sourceIsArray = Array.isArray(source);
    	var targetIsArray = Array.isArray(target);
    	var sourceAndTargetTypesMatch = sourceIsArray === targetIsArray;

    	if (!sourceAndTargetTypesMatch) {
    		return cloneUnlessOtherwiseSpecified(source, options)
    	} else if (sourceIsArray) {
    		return options.arrayMerge(target, source, options)
    	} else {
    		return mergeObject(target, source, options)
    	}
    }

    deepmerge.all = function deepmergeAll(array, options) {
    	if (!Array.isArray(array)) {
    		throw new Error('first argument should be an array')
    	}

    	return array.reduce(function(prev, next) {
    		return deepmerge(prev, next, options)
    	}, {})
    };

    var deepmerge_1 = deepmerge;

    var es = /*#__PURE__*/Object.freeze({
        default: deepmerge_1
    });

    var deepmerge$1 = ( es && deepmerge_1 ) || es;

    var model = createCommonjsModule(function (module) {
    module.exports = {
        extend: (base, target, options = {}) => {
            const fieldsToMerge = (target.fields || []).map(df => df.fieldname);
            const fieldsToRemove = options.skipFields || [];

            base.fields = base.fields
                .filter(df => !fieldsToRemove.includes(df.fieldname))
                .map(df => {
                    if (fieldsToMerge.includes(df.fieldname)) {
                        return deepmerge$1(df, target.fields.find(tdf => tdf.fieldname === df.fieldname));
                    }
                    return df;
                });

            const overrideProps = options.overrideProps || [];
            for (let prop of overrideProps) {
                if (base.hasOwnProperty(prop)) {
                    delete base[prop];
                }
            }

            return deepmerge$1(base, target);
        },
        commonFields: [
            {
                fieldname: 'name', fieldtype: 'Data', required: 1
            }
        ],
        parentFields: [
            {
                fieldname: 'owner', fieldtype: 'Data', required: 1
            },
            {
                fieldname: 'modifiedBy', fieldtype: 'Data', required: 1
            },
            {
                fieldname: 'creation', fieldtype: 'Datetime', required: 1
            },
            {
                fieldname: 'modified', fieldtype: 'Datetime', required: 1
            },
            {
                fieldname: 'keywords', fieldtype: 'Text'
            }
        ],
        childFields: [
            {
                fieldname: 'idx', fieldtype: 'Int', required: 1
            },
            {
                fieldname: 'parent', fieldtype: 'Data', required: 1
            },
            {
                fieldname: 'parenttype', fieldtype: 'Data', required: 1
            },
            {
                fieldname: 'parentfield', fieldtype: 'Data', required: 1
            }
        ],
        treeFields: [
            {
                fieldname: 'lft', fieldtype: 'Int'
            },
            {
                fieldname: 'rgt', fieldtype: 'Int'
            }
        ]
    };
    });
    var model_1 = model.extend;
    var model_2 = model.commonFields;
    var model_3 = model.parentFields;
    var model_4 = model.childFields;
    var model_5 = model.treeFields;

    var meta = class BaseMeta extends document$1 {
        constructor(data) {
            super(data);
            this.setDefaultIndicators();
            if (this.setupMeta) {
                this.setupMeta();
            }
            if (!this.titleField) {
                this.titleField = 'name';
            }
        }

        hasField(fieldname) {
            return this.getField(fieldname) ? true : false;
        }

        getField(fieldname) {
            if (!this._field_map) {
                this._field_map = {};
                for (let field of this.fields) {
                    this._field_map[field.fieldname] = field;
                }
            }
            return this._field_map[fieldname];
        }

        getLabel(fieldname) {
            return this.getField(fieldname).label;
        }

        getTableFields() {
            if (this._tableFields===undefined) {
                this._tableFields = this.fields.filter(field => field.fieldtype === 'Table');
            }
            return this._tableFields;
        }

        getFormulaFields() {
            if (this._formulaFields===undefined) {
                this._formulaFields = this.fields.filter(field => field.formula);
            }
            return this._formulaFields;
        }

        hasFormula() {
            if (this._hasFormula===undefined) {
                this._hasFormula = false;
                if (this.getFormulaFields().length) {
                    this._hasFormula = true;
                } else {
                    for (let tablefield of this.getTableFields()) {
                        if (frappejs.getMeta(tablefield.childtype).getFormulaFields().length) {
                            this._hasFormula = true;
                            break;
                        }
                    }
                }
            }
            return this._hasFormula;
        }

        async set(fieldname, value) {
            this[fieldname] = value;
            await this.trigger(fieldname);
        }

        get(fieldname) {
            return this[fieldname];
        }

        getValidFields({ withChildren = true } = {}) {
            if (!this._validFields) {

                this._validFields = [];
                this._validFieldsWithChildren = [];

                const _add = (field) => {
                    this._validFields.push(field);
                    this._validFieldsWithChildren.push(field);
                };

                const doctype_fields = this.fields.map((field) => field.fieldname);

                // standard fields
                for (let field of model.commonFields) {
                    if (frappejs.db.typeMap[field.fieldtype] && !doctype_fields.includes(field.fieldname)) {
                        _add(field);
                    }
                }

                if (this.isSubmittable) {
                    _add({fieldtype:'Check', fieldname: 'submitted', label: frappejs._('Submitted')});
                }

                if (this.isChild) {
                    // child fields
                    for (let field of model.childFields) {
                        if (frappejs.db.typeMap[field.fieldtype] && !doctype_fields.includes(field.fieldname)) {
                            _add(field);
                        }
                    }
                } else {
                    // parent fields
                    for (let field of model.parentFields) {
                        if (frappejs.db.typeMap[field.fieldtype] && !doctype_fields.includes(field.fieldname)) {
                            _add(field);
                        }
                    }
                }

                if (this.isTree) {
                    // tree fields
                    for (let field of model.treeFields) {
                        if (frappejs.db.typeMap[field.fieldtype] && !doctype_fields.includes(field.fieldname)) {
                            _add(field);
                        }
                    }
                }

                // doctype fields
                for (let field of this.fields) {
                    let include = frappejs.db.typeMap[field.fieldtype];

                    if (include) {
                        _add(field);
                    }

                    // include tables if (withChildren = True)
                    if (!include && field.fieldtype === 'Table') {
                        this._validFieldsWithChildren.push(field);
                    }
                }
            }

            if (withChildren) {
                return this._validFieldsWithChildren;
            } else {
                return this._validFields;
            }
        }

        getKeywordFields() {
            if (!this._keywordFields) {
                this._keywordFields = this.keywordFields;
                if (!(this._keywordFields && this._keywordFields.length && this.fields)) {
                    this._keywordFields = this.fields.filter(field => field.fieldtype !== 'Table' && field.required).map(field => field.fieldname);
                }
                if (!(this._keywordFields && this._keywordFields.length)) {
                    this._keywordFields = ['name'];
                }
            }
            return this._keywordFields;
        }

        validateSelect(field, value) {
            let options = field.options;
            if (!options) return;

            if (typeof options === 'string') {
                // values given as string
                options = field.options.split('\n');
            }
            if (!options.includes(value)) {
                throw new frappejs.errors.ValueError(`${value} must be one of ${options.join(", ")}`);
            }
            return value;
        }

        async trigger(event, params = {}) {
            Object.assign(params, {
                doc: this,
                name: event
            });

            await super.trigger(event, params);
        }

        setDefaultIndicators() {
            if (!this.indicators) {
                if (this.isSubmittable) {
                    this.indicators = {
                        key: 'submitted',
                        colors: {
                            0: 'gray',
                            1: 'blue'
                        }
                    };
                }
            }
        }

        getIndicatorColor(doc) {
            if (frappejs.isDirty(this.name, doc.name)) {
                return 'orange';
            } else {
                if (this.indicators) {
                    let value = doc[this.indicators.key];
                    if (value) {
                        return this.indicators.colors[value] || 'gray';
                    } else {
                        return 'gray';
                    }
                } else {
                    return 'gray';
                }
            }
        }
    };

    var common = {
        initLibs(frappe) {
            Object.assign(frappe, utils);
            Object.assign(frappe, number_format);
            Object.assign(frappe, format);
            frappe.errors = errors;
            frappe.BaseDocument = document$1;
            frappe.BaseMeta = meta;
        }
    };

    var Email = {
        name: "Email",
        doctype: "DocType",
        isSingle: 0,

        keywordFields:[
            "receiver",
            "subject",
            "message"
        ],

        fields: [
            {
                fieldname: "sender",
                label: "Sender Name",
                fieldtype: "Data",
                required: 1
            },
            {
                fieldname: "receiver",
                label: "Receiver Name",
                fieldtype: "Data",
                required: 1
            },
            {
                fieldname: "subject",
                label: "Subject",
                fieldtype: "Data"
            },
            {
                fieldname: "message",
                label: "Message",
                fieldtype: "Long Text",
                required: 1
            }
        ]
    };

    var models = {
        models:{
            Email: Email
        }
    };

    var FilterItem = {
        name: "FilterItem",
        doctype: "DocType",
        isSingle: 0,
        isChild: 1,
        keywordFields: [],
        fields: [
            {
                fieldname: "field",
                label: "Field",
                fieldtype: "Select",
                required: 1
            },
            {
                fieldname: "condition",
                label: "Condition",
                fieldtype: "Select",
                options: [
                    'Equals',
                    '>',
                    '<',
                    '>=',
                    '<=',
                    'Between',
                    'Includes',
                    'One Of'
                ],
                required: 1
            },
            {
                fieldname: "value",
                label: "Value",
                fieldtype: "Data",
            }
        ]
    };

    var FilterGroup = {
        name: "FilterGroup",
        isSingle: 0,
        isChild: 0,
        keywordFields: [],
        fields: [
            {
                fieldname: "name",
                label: "Name",
                fieldtype: "Data",
                required: 1
            },
            {
                fieldname: "forDocType",
                label: "Document Type",
                fieldtype: "Data",
                required: 1,
                disabled: 1,
            },
            {
                fieldname: "items",
                fieldtype: "Table",
                childtype: "FilterItem",
                label: "Items",
                required: 1
            }
       ]
    };

    var FilterSelectorDocument = class FormSelector extends document$1 {
        reset(doctype) {
            if (doctype) {
                this.forDocType = doctype;
            }
            this.items = [];
            this.filterGroup = '';
            this.filterGroupName = '';
        }

        getFilters() {
            const filters = {};
            for (let item of (this.items || [])) {
                filters[item.field] = [(item.condition === 'Equals') ? '=' : item.condition,
                    item.value];
            }
            return filters;
        }

        setFilters(filters) {
            this.reset();
            for (let key in filters) {
                let value  = filters[key];
                if (value instanceof Array) {
                    this.items.push({field: key, condition: value[0], value: value[1]});
                } else {
                    this.items.push({field: key, condition: 'Equals', value: value});
                }
            }
        }

        getText() {
            if (this.items && this.items.length) {
                this.forMeta = frappejs.getMeta(this.forDocType);
                return this.items.map(v => `${this.forMeta.getLabel(v.field)} ${v.condition} ${v.value}`).join(', ');
            } else {
                return 'Set Filters';
            }
        }

        async update() {
            // save new group filter
            if (frappejs.isServer) {
                if (this.filterGroupName) {
                    await this.makeFilterGroup();
                } else if (this.filterGroup) {
                    await this.updateFilterGroup();
                }
                return this;
            } else {
                return super.update();
            }
        }

        async makeFilterGroup() {
            const filterGroup = frappejs.newDoc({doctype:'FilterGroup'});
            filterGroup.name = this.filterGroupName;
            this.updateFilterGroupValues(filterGroup);
            await filterGroup.insert();
        }

        async updateFilterGroup() {
            const filterGroup = await frappejs.getDoc('FilterGroup', this.filterGroup);
            this.updateFilterGroupValues(filterGroup);
            await filterGroup.update();
        }

        updateFilterGroupValues(filterGroup) {
            filterGroup.forDocType = this.forDocType;
            filterGroup.items = [];
            for (let item of this.items) {
                filterGroup.items.push({field: item.field, condition: item.condition, value: item.value});
            }
        }
    };

    var FilterSelector = createCommonjsModule(function (module) {
    module.exports = {
        name: "FilterSelector",
        label: "Set Filters",
        documentClass: FilterSelectorDocument,
        isSingle: 1,
        isChild: 0,
        keywordFields: [],
        fields: [
            {
                fieldname: "forDocType",
                label: "Document Type",
                fieldtype: "Data",
                hidden: 1,
            },
            {
                fieldname: "filterGroup",
                label: "Saved Filters",
                fieldtype: "Link",
                target: "FilterGroup",
                getFilters: (query, control) => {
                    return {
                        forDocType: control.doc.forDocType,
                        keywords: ["like", query]
                    }
                }
            },
            {
                fieldname: "filterGroupName",
                label: "New Filter Name",
                fieldtype: "Data",
            },
            {
                fieldname: "items",
                label: "Items",
                fieldtype: "Table",
                childtype: "FilterItem",
                neverEmpty: 1,

                // copy items from saved filter group
                formula: async (doc) => {
                    if (doc._lastFilterGroup !== doc.filterGroup) {
                        // fitler changed

                        if (doc.filterGroup) {
                            doc.items = [];
                            const filterGroup = await frappejs.getDoc('FilterGroup', doc.filterGroup);

                            // copy items
                            for(let source of filterGroup.items) {
                                const item = Object.assign({}, source);
                                item.parent = item.name = '';
                                doc.items.push(item);
                            }
                        } else {
                            // no filter group selected
                            doc.items = [{idx: 0}];
                        }

                        doc._lastFilterGroup = doc.filterGroup;
                    }
                    return false;
                },
            }
        ],

        formEvents: {
            // set the fields of the selected item in the 'select'
            refresh: (form) => {
                // override the `getOptions` method in the `field` property
                frappejs.getMeta('FilterItem').getField('field').getOptions = () => {
                    return frappejs.getMeta(form.doc.forDocType).fields.map((f) => {
                        return {label: f.label, value: f.fieldname};
                    });
                };
            }
        }
    };
    });
    var FilterSelector_1 = FilterSelector.name;
    var FilterSelector_2 = FilterSelector.label;
    var FilterSelector_3 = FilterSelector.documentClass;
    var FilterSelector_4 = FilterSelector.isSingle;
    var FilterSelector_5 = FilterSelector.isChild;
    var FilterSelector_6 = FilterSelector.keywordFields;
    var FilterSelector_7 = FilterSelector.fields;
    var FilterSelector_8 = FilterSelector.formEvents;

    var NumberSeriesDocument = class NumberSeries extends document$1 {
        validate() {
            if (this.current===null || this.current===undefined) {
                this.current = 0;
            }
        }
        async next() {
            this.validate();
            this.current++;
            await this.update();
            return this.current;
        }
    };

    var NumberSeries = {
        "name": "NumberSeries",
        "documentClass": NumberSeriesDocument,
        "doctype": "DocType",
        "isSingle": 0,
        "isChild": 0,
        "keywordFields": [],
        "fields": [
            {
                "fieldname": "name",
                "label": "Prefix",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "current",
                "label": "Current",
                "fieldtype": "Int",
                "required": 1
            }
        ]
    };

    var PrintFormat = {
        name: "PrintFormat",
        label: "Print Format",
        doctype: "DocType",
        isSingle: 0,
        isChild: 0,
        keywordFields: [],
        fields: [
            {
                fieldname: "name",
                label: "Name",
                fieldtype: "Data",
                required: 1
            },
            {
                fieldname: "for",
                label: "For",
                fieldtype: "Data",
                required: 1
            },
            {
                fieldname: "template",
                label: "Template",
                fieldtype: "Code",
                required: 1,
                options: {
                    mode: 'text/html'
                }
            }
        ]
    };

    var Role = {
        "name": "Role",
        "doctype": "DocType",
        "isSingle": 0,
        "isChild": 0,
        "keywordFields": [],
        "fields": [
            {
                "fieldname": "name",
                "label": "Name",
                "fieldtype": "Data",
                "required": 1
            }
        ]
    };

    var Session = {
        "name": "Session",
        "doctype": "DocType",
        "isSingle": 0,
        "isChild": 0,
        "keywordFields": [],
        "fields": [
            {
                "fieldname": "username",
                "label": "Username",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "password",
                "label": "Password",
                "fieldtype": "Password",
                "required": 1
            }
        ]
    };

    var SingleValue = {
        "name": "SingleValue",
        "doctype": "DocType",
        "isSingle": 0,
        "isChild": 0,
        "keywordFields": [],
        "fields": [
            {
                "fieldname": "parent",
                "label": "Parent",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "fieldname",
                "label": "Fieldname",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "value",
                "label": "Value",
                "fieldtype": "Data",
                "required": 1
            }
        ]
    };

    var SystemSettings = {
        name: "SystemSettings",
        label: "System Settings",
        doctype: "DocType",
        isSingle: 1,
        isChild: 0,
        keywordFields: [],
        fields: [
            {
                fieldname: "dateFormat",
                label: "Date Format",
                fieldtype: "Select",
                options: [
                    "dd/mm/yyyy",
                    "mm/dd/yyyy",
                    "dd-mm-yyyy",
                    "mm-dd-yyyy",
                    "yyyy-mm-dd"
                ],
                default: "yyyy-mm-dd",
                required: 1
            }
        ]
    };

    var ToDo = {
        name: "ToDo",
        label: "To Do",
        naming: "autoincrement",
        pageSettings: {
            hideTitle: true
        },
        "isSingle": 0,
        "keywordFields": [
            "subject",
            "description"
        ],
        titleField: 'subject',
        indicators: {
            key: 'status',
            colors: {
                Open: 'gray',
                Closed: 'green'
            }
        },
        "fields": [
            {
                "fieldname": "subject",
                "label": "Subject",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "status",
                "label": "Status",
                "fieldtype": "Select",
                "options": [
                    "Open",
                    "Closed"
                ],
                "default": "Open",
                "required": 1
            },
            {
                "fieldname": "description",
                "label": "Description",
                "fieldtype": "Text"
            }
        ],

        links: [
            {
                label: 'Close',
                condition: (form) => form.doc.status !== 'Closed',
                action: async (form) => {
                    await form.doc.set('status', 'Closed');
                    await form.doc.update();
                }
            },
            {
                label: 'Re-Open',
                condition: (form) => form.doc.status !== 'Open',
                action: async (form) => {
                    await form.doc.set('status', 'Open');
                    await form.doc.update();
                }
            }
        ]
    };

    var User = {
        "name": "User",
        "doctype": "DocType",
        "isSingle": 0,
        "isChild": 0,
        "keywordFields": [
            "name",
            "fullName"
        ],
        "fields": [
            {
                "fieldname": "name",
                "label": "Email",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "password",
                "label": "Password",
                "fieldtype": "Password",
                "required": 1,
                "hidden": 1,
            },
            {
                "fieldname": "fullName",
                "label": "Full Name",
                "fieldtype": "Data",
                "required": 1
            },
            {
                "fieldname": "roles",
                "label": "Roles",
                "fieldtype": "Table",
                "childtype": "UserRole"
            },
            {
                "fieldname": "userId",
                "label": "User ID",
                "fieldtype": "Data",
                "hidden": 1
            }
        ]
    };

    var UserRole = {
        "name": "UserRole",
        "doctype": "DocType",
        "isSingle": 0,
        "isChild": 1,
        "keywordFields": [],
        "fields": [
            {
                "fieldname": "role",
                "label": "Role",
                "fieldtype": "Link",
                "target": "Role"
            }
        ]
    };

    var models$1 = {
        models: {
            FilterItem: FilterItem,
            FilterGroup: FilterGroup,
            FilterSelector: FilterSelector,
            NumberSeries: NumberSeries,
            PrintFormat: PrintFormat,
            Role: Role,
            Session: Session,
            SingleValue: SingleValue,
            SystemSettings: SystemSettings,
            ToDo: ToDo,
            User: User,
            UserRole: UserRole
        }
    };

    var http = class HTTPClient extends observable {
        constructor({ server, protocol = 'http' }) {
            super();

            this.server = server;
            this.protocol = protocol;
            frappejs.config.serverURL = this.getURL();

            // if the backend is http, then always client!
            frappejs.isServer = false;

            this.initTypeMap();
        }

        connect() {

        }

        async insert(doctype, doc) {
            doc.doctype = doctype;
            let url = this.getURL('/api/resource', doctype);
            return await this.fetch(url, {
                method: 'POST',
                body: JSON.stringify(doc)
            })
        }

        async get(doctype, name) {
            let url = this.getURL('/api/resource', doctype, name);
            return await this.fetch(url, {
                method: 'GET',
                headers: this.getHeaders()
            })
        }

        async getAll({ doctype, fields, filters, start, limit, sort_by, order }) {
            let url = this.getURL('/api/resource', doctype);

            url = url + "?" + frappejs.getQueryString({
                fields: JSON.stringify(fields),
                filters: JSON.stringify(filters),
                start: start,
                limit: limit,
                sort_by: sort_by,
                order: order
            });

            return await this.fetch(url, {
                method: 'GET',
            });
        }

        async update(doctype, doc) {
            doc.doctype = doctype;
            let url = this.getURL('/api/resource', doctype, doc.name);

            return await this.fetch(url, {
                method: 'PUT',
                body: JSON.stringify(doc)
            });
        }

        async delete(doctype, name) {
            let url = this.getURL('/api/resource', doctype, name);

            return await this.fetch(url, {
                method: 'DELETE',
            });
        }

        async deleteMany(doctype, names) {
            let url = this.getURL('/api/resource', doctype);

            return await this.fetch(url, {
                method: 'DELETE',
                body: JSON.stringify(names)
            });
        }

        async exists(doctype, name) {
            return (await this.getValue(doctype, name, 'name')) ? true : false;
        }

        async getValue(doctype, name, fieldname) {
            let url = this.getURL('/api/resource', doctype, name, fieldname);

            return (await this.fetch(url, {
                method: 'GET',
            })).value;
        }

        async fetch(url, args) {
            args.headers = this.getHeaders();
            let response = await frappejs.fetch(url, args);
            let data = await response.json();

            if (response.status !== 200) {
                throw Error(data.error);
            }

            return data;
        }

        getURL(...parts) {
            return this.protocol + '://' + this.server + (parts || []).join('/');
        }

        getHeaders() {
            const headers = {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            };
            if (frappejs.session && frappejs.session.token) {
                headers.token = frappejs.session.token;
            }        return headers;
        }

        initTypeMap() {
            this.typeMap = {
                'Autocomplete': true
                , 'Currency': true
                , 'Int': true
                , 'Float': true
                , 'Percent': true
                , 'Check': true
                , 'Small Text': true
                , 'Long Text': true
                , 'Code': true
                , 'Text Editor': true
                , 'Date': true
                , 'Datetime': true
                , 'Time': true
                , 'Text': true
                , 'Data': true
                , 'Link': true
                , 'DynamicLink': true
                , 'Password': true
                , 'Select': true
                , 'Read Only': true
                , 'File': true
                , 'Attach': true
                , 'Attach Image': true
                , 'Signature': true
                , 'Color': true
                , 'Barcode': true
                , 'Geolocation': true
            };
        }

        close() {

        }

    };

    const server = 'localhost:8000';
    window.frappe = frappejs;
    frappejs.init();
    frappejs.registerLibs(common);
    frappejs.registerModels(models$1);
    frappejs.registerModels(models);
    frappejs.fetch = window.fetch.bind();
    frappejs.db = new http({ server });
    frappejs.docs = new observable();

    const sendBtn = document.getElementById("send");

    sendBtn.onclick = function(){

        const senderEl = document.getElementById("sender");
        const receiverEl = document.getElementById("receiver");
        const subjectEl = document.getElementById("subject");
        const messageEl = document.getElementById("message");

        const sender = senderEl.value;
        const receiver = receiverEl.value;
        const subject = subjectEl.value || "No Subject";
        const message = messageEl.value;

        const data = frappejs.newDoc({
            doctype: 'Email',
            sender: sender,
            receiver: receiver,
            subject: subject,
            message: message
        });

        data.insert();
    };

    var src = {

    };

    return src;

}());
//# sourceMappingURL=bundle.js.map
