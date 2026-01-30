FROM headscale/headscale:0.27.1

COPY start.sh /app/code/start.sh
RUN chmod +x /app/code/start.sh

EXPOSE 8080
EXPOSE 3478/udp

CMD ["/app/code/start.sh"]
