Opción A (la que te recomendaría): YOLOv8 exportado a ONNX + ONNX Runtime Web ⭐⭐⭐⭐

Podés convertir tu modelo:

yolo export model=yolov8n.pt format=onnx

te genera:

yolov8n.onnx

Después en el browser:

onnxruntime-web

ejecuta el modelo.

Ventajas:

corre totalmente local
funciona en Chrome/Edge modernos
usa CPU o WebGPU
no necesitás backend

Desventajas:

hay que reescribir la parte OpenCV Python en JS