#!/usr/bin/env python3
"""Stable local browser tunnel through the test VM to the Gateway Service."""
import ipaddress,subprocess,tempfile
K=['/opt/homebrew/bin/kubectl','--context','colima-s2t-stress','-n','s2t-stress-20261005']
address=str(ipaddress.ip_address(subprocess.check_output(K+['get','service','gateway','-o','jsonpath={.spec.clusterIP}'],text=True)))
config=subprocess.check_output(['colima','ssh-config','--profile','s2t-stress'],text=True)
with tempfile.NamedTemporaryFile(mode='w',prefix='s2t-perf-ssh-') as file:
    file.write(config);file.flush()
    subprocess.run(['ssh','-F',file.name,'-N','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L',f'127.0.0.1:18787:{address}:8787','colima-s2t-stress'],check=True)
