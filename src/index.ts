// Bucle principal: carga la configuración y ejecuta una comprobación cada INTERVALO_MINUTOS (mínimo 5).
// En cada vuelta: navegador → calendario → si hay día < FECHA_LIMITE, notificar → logger.
// Si aparece un control antibots, se detiene y avisa.
