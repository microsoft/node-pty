# node-pty-prebuilt
在windwos下spawn函数的opt选项添加了exePath，可以指定 exePath的位置.

The spawn function's opt option has been added with agentExePath, which allows specifying the location of the agent executable.

https://github.com/microsoft/node-pty

1. 在windows下useConpty如果开启，不能在debug模式下运行，useConptyDll如果开启了，你依然可以用exePath参数来指定它所需要的dll位置，不提供会使用项目默认的。
2. 已经适配webpack打包
