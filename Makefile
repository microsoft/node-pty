all:
	@type node-gyp > /dev/null 2>&1 && make gyp || make waf

waf:
	node-waf configure build

gyp:
	node-gyp configure
	node-gyp build

clean:
	@type node-gyp > /dev/null 2>&1 && make clean-waf || make clean-gyp

clean-waf:
	@rm -rf ./build .lock-wscript

clean-gyp:
	@type node-gyp > /dev/null && node-gyp clean 2>/dev/null

.PHONY: all waf gyp clean clean-waf clean-gyp
