import { useEffect, useRef, useState, type ComponentProps } from "react"
import { ResponsiveContainer as RechartsResponsiveContainer } from "recharts"

// 其余图表组件原样透出
export * from "recharts"

/**
 * Recharts 的 ResponsiveContainer 在容器尺寸为 0（切视图、HMR 重挂载、布局尚未完成）
 * 时会按 width(-1)/height(-1) 渲染并刷警告。这里先量到父容器有尺寸再挂载真正的容器，
 * 避免零尺寸那一次渲染。
 */
export function ResponsiveContainer(props: ComponentProps<typeof RechartsResponsiveContainer>) {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const box = el.getBoundingClientRect()
      setReady(box.width > 1 && box.height > 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="size-full">
      {ready ? <RechartsResponsiveContainer {...props} /> : null}
    </div>
  )
}
